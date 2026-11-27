package com.moodvoice.api.controller;

import com.cloudinary.Cloudinary;
import com.cloudinary.utils.ObjectUtils;
import com.moodvoice.api.entity.VoiceRecord;
import com.moodvoice.api.repository.VoiceRecordRepository;
import com.moodvoice.api.service.AudioCryptoService;
import com.moodvoice.api.service.AudioProcessingService;
import com.moodvoice.api.dto.MlAnalysisResponse;
import com.moodvoice.api.service.MlServiceClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/audio")
@CrossOrigin(origins = "*")
public class AudioController {

    private static final long MAX_FILE_SIZE_BYTES = 25L * 1024 * 1024;

    @Autowired
    private VoiceRecordRepository voiceRecordRepository;

    @Autowired(required = false)
    private Cloudinary cloudinary;

    @Autowired
    private AudioProcessingService audioProcessingService;

    @Autowired
    private AudioCryptoService audioCryptoService;

    @Autowired
    private MlServiceClient mlServiceClient;

    @Value("${app.audio.storage-dir:uploads/audio}")
    private String storageDir;

    private boolean canAccessRecord(VoiceRecord record, Authentication authentication) {
        return record.getUserEmail().equalsIgnoreCase(authentication.getName());
    }

    @PostMapping("/upload")
    public ResponseEntity<?> uploadAudio(@RequestParam("file") MultipartFile file,
                                         Authentication authentication) {
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Файл порожній",
                    "status", "error"
            ));
        }
        if (file.getSize() > MAX_FILE_SIZE_BYTES) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Файл перевищує ліміт 25 МБ",
                    "status", "error"
            ));
        }

        String email = authentication.getName();
        byte[] audioBytes = null;
        try {
            audioBytes = file.getBytes();

            byte[] encryptedBytes = audioCryptoService.encrypt(audioBytes);
            Path dirPath = Paths.get(storageDir);
            Files.createDirectories(dirPath);

            String encryptedFilename = UUID.randomUUID() + ".enc";
            Path encryptedFilePath = dirPath.resolve(encryptedFilename);
            Files.write(encryptedFilePath, encryptedBytes);

            VoiceRecord record = new VoiceRecord(email, encryptedFilePath.toString(), file.getSize());
            record.setCloudinaryPublicId(null);
            record.setStatus("PENDING");

            VoiceRecord saved = voiceRecordRepository.save(record);

            audioProcessingService.processAudioAsync(saved.getId(), audioBytes, file.getOriginalFilename());

            return ResponseEntity.accepted().body(Map.of(
                    "message", "Аудіо зашифровано (AES-256) та передано на фоновий AI-аналіз!",
                    "status", "success",
                    "recordId", saved.getId().toString(),
                    "record", saved
            ));

        } catch (Exception e) {
            if (audioBytes != null) {
                Arrays.fill(audioBytes, (byte) 0);
            }
            System.err.println("Помилка завантаження аудіо: " + e.getMessage());
            return ResponseEntity.internalServerError().body(Map.of(
                    "message", "Помилка сервера: " + e.getMessage(),
                    "status", "error"
            ));
        }
    }

    @GetMapping("/status/{id}")
    public ResponseEntity<?> getRecordStatus(@PathVariable Long id, Authentication authentication) {
        VoiceRecord record = voiceRecordRepository.findById(id).orElse(null);
        if (record == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                    "status", "error",
                    "message", "Запис не знайдено"
            ));
        }
        if (!canAccessRecord(record, authentication)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                    "status", "error",
                    "message", "Немає доступу до цього запису"
            ));
        }
        return ResponseEntity.ok(Map.of(
                "id", record.getId(),
                "status", record.getStatus() != null ? record.getStatus() : "COMPLETED",
                "record", record
        ));
    }

    @PostMapping("/{id}/retry")
    public ResponseEntity<?> retryAnalysis(@PathVariable Long id, Authentication authentication) {
        byte[] audioBytes = null;
        try {
            VoiceRecord record = voiceRecordRepository.findById(id)
                    .orElseThrow(() -> new RuntimeException("Запис не знайдено"));

            if (!canAccessRecord(record, authentication)) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                        "status", "error",
                        "message", "Немає доступу до цього запису"
                ));
            }

            Path filePath = Paths.get(record.getFilePath());
            if (!Files.exists(filePath)) {
                return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of(
                        "status", "error",
                        "message", "Аудіофайл не знайдено на диску"
                ));
            }

            byte[] fileBytes = Files.readAllBytes(filePath);
            audioBytes = record.getFilePath().endsWith(".enc")
                    ? audioCryptoService.decrypt(fileBytes)
                    : fileBytes;

            record.setStatus("PENDING");
            voiceRecordRepository.save(record);

            audioProcessingService.processAudioAsync(record.getId(), audioBytes, "record-" + id + ".webm");

            return ResponseEntity.accepted().body(Map.of(
                    "status", "success",
                    "message", "Повторний аналіз запущено",
                    "record", record
            ));
        } catch (Exception e) {
            if (audioBytes != null) {
                Arrays.fill(audioBytes, (byte) 0);
            }
            return ResponseEntity.internalServerError().body(Map.of(
                    "status", "error",
                    "message", "Не вдалося перезапустити аналіз: " + e.getMessage()
            ));
        }
    }

    @GetMapping("/play/{id}")
    public ResponseEntity<Resource> playAudio(@PathVariable Long id, Authentication authentication) {
        try {
            VoiceRecord record = voiceRecordRepository.findById(id)
                    .orElseThrow(() -> new RuntimeException("Запис не знайдено"));

            if (!canAccessRecord(record, authentication)) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
            }

            if (record.getFilePath().startsWith("http://") || record.getFilePath().startsWith("https://")) {
                return ResponseEntity.status(HttpStatus.FOUND)
                        .location(URI.create(record.getFilePath()))
                        .build();
            }

            Path filePath = Paths.get(record.getFilePath());
            if (!Files.exists(filePath)) {
                return ResponseEntity.notFound().build();
            }

            byte[] fileBytes = Files.readAllBytes(filePath);
            byte[] audioBytes = record.getFilePath().endsWith(".enc")
                    ? audioCryptoService.decrypt(fileBytes)
                    : fileBytes;

            ByteArrayResource resource = new ByteArrayResource(audioBytes);
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType("audio/webm"))
                    .contentLength(audioBytes.length)
                    .cacheControl(CacheControl.noStore())
                    .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"record-" + id + ".webm\"")
                    .body(resource);

        } catch (Exception e) {
            System.err.println("Помилка відтворення: " + e.getMessage());
            return ResponseEntity.internalServerError().build();
        }
    }

    @GetMapping("/history")
    public ResponseEntity<?> getUserHistory(Authentication authentication) {
        try {
            List<VoiceRecord> records = voiceRecordRepository
                    .findByUserEmailOrderByCreatedAtDesc(authentication.getName());
            return ResponseEntity.ok(records);
        } catch (Exception e) {
            return ResponseEntity.internalServerError()
                    .body(Map.of("message", "Помилка отримання історії: " + e.getMessage()));
        }
    }

    @DeleteMapping("/delete/{id}")
    public ResponseEntity<?> deleteAudio(@PathVariable Long id, Authentication authentication) {
        try {
            VoiceRecord record = voiceRecordRepository.findById(id)
                    .orElseThrow(() -> new RuntimeException("Запис не знайдено"));

            if (!canAccessRecord(record, authentication)) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of(
                        "status", "error",
                        "message", "Немає доступу до цього запису"
                ));
            }

            if (record.getCloudinaryPublicId() != null && cloudinary != null) {
                cloudinary.uploader().destroy(
                        record.getCloudinaryPublicId(),
                        ObjectUtils.asMap("resource_type", "video")
                );
            } else if (!record.getFilePath().startsWith("http://") && !record.getFilePath().startsWith("https://")) {
                Files.deleteIfExists(Paths.get(record.getFilePath()));
            }

            voiceRecordRepository.delete(record);

            return ResponseEntity.ok(Map.of(
                    "status", "success",
                    "message", "Запис успішно видалено"
            ));

        } catch (Exception e) {
            System.err.println("Помилка видалення: " + e.getMessage());
            return ResponseEntity.internalServerError().body(Map.of(
                    "status", "error",
                    "message", e.getMessage()
            ));
        }
    }

    @PostMapping("/demo")
    public ResponseEntity<?> demoAnalyze(@RequestParam("file") MultipartFile file) {
        if (file.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Файл порожній",
                    "status", "error"
            ));
        }
        if (file.getSize() > MAX_FILE_SIZE_BYTES) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Файл перевищує ліміт 25 МБ",
                    "status", "error"
            ));
        }

        byte[] audioBytes = null;
        try {
            audioBytes = file.getBytes();
            MlAnalysisResponse mlResult = mlServiceClient.analyzeAudio(audioBytes, file.getOriginalFilename());
            if (mlResult == null) {
                throw new RuntimeException("ML-сервіс не відповів");
            }

            VoiceRecord demoRecord = new VoiceRecord("guest@demo", "", file.getSize());
            demoRecord.setStatus("COMPLETED");
            demoRecord.setTranscription(mlResult.transcript());
            demoRecord.setMoodType(mlResult.overall_mood());
            demoRecord.setConfidence(mlResult.confidence());
            demoRecord.setIsLowConfidence(mlResult.is_low_confidence());
            demoRecord.setCrisisDetected(mlResult.crisis_detected());
            demoRecord.setCrisisMessage(mlResult.crisis_message());
            demoRecord.setMoodArtBase64(mlResult.mood_art_base64());

            if (mlResult.emotions() != null) {
                demoRecord.setCalmScore(mlResult.emotions().getOrDefault("calm", 0.0));
                demoRecord.setJoyScore(mlResult.emotions().getOrDefault("joy", 0.0));
                demoRecord.setSadnessScore(mlResult.emotions().getOrDefault("sadness", 0.0));
                demoRecord.setStressScore(mlResult.emotions().getOrDefault("stress", 0.0));
            }

            return ResponseEntity.ok(Map.of(
                    "message", "Демо-аналіз завершено (без збереження)",
                    "status", "success",
                    "record", demoRecord
            ));
        } catch (Exception e) {
            System.err.println("Помилка демо-аналізу: " + e.getMessage());
            return ResponseEntity.internalServerError().body(Map.of(
                    "message", "Помилка ML-аналізу: " + e.getMessage(),
                    "status", "error"
            ));
        } finally {
            if (audioBytes != null) {
                Arrays.fill(audioBytes, (byte) 0);
            }
        }
    }
}