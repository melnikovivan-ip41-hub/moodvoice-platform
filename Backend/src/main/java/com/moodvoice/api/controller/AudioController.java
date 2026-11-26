package com.moodvoice.api.controller;

import com.cloudinary.Cloudinary;
import com.cloudinary.utils.ObjectUtils;
import com.moodvoice.api.dto.MlAnalysisResponse;
import com.moodvoice.api.entity.VoiceRecord;
import com.moodvoice.api.repository.VoiceRecordRepository;
import com.moodvoice.api.service.MlServiceClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.Resource;
import org.springframework.core.io.UrlResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/audio")
@CrossOrigin(origins = "*")
public class AudioController {

    @Autowired
    private VoiceRecordRepository voiceRecordRepository;

    @Autowired
    private Cloudinary cloudinary;

    @Autowired
    private MlServiceClient mlServiceClient;

    @PostMapping("/upload")
    public ResponseEntity<?> uploadAudio(@RequestParam("file") MultipartFile file,
                                         @RequestParam("email") String email) {
        try {
            byte[] audioBytes = file.getBytes();

            // 1. Загружаем аудио в Cloudinary
            @SuppressWarnings("unchecked")
            Map<String, Object> uploadResult = cloudinary.uploader().upload(
                    audioBytes,
                    ObjectUtils.asMap("resource_type", "video")
            );
            String cloudUrl = uploadResult.get("secure_url").toString();
            String publicId = uploadResult.get("public_id") != null
                    ? uploadResult.get("public_id").toString()
                    : null;

            // 2. Отправляем аудио на анализ в наш FastAPI ML-сервис
            MlAnalysisResponse mlResult = mlServiceClient.analyzeAudio(audioBytes, file.getOriginalFilename());

            // 3. Сохраняем реальные результаты анализа в PostgreSQL
            VoiceRecord record = new VoiceRecord(email, cloudUrl, file.getSize());
            record.setCloudinaryPublicId(publicId);

            if (mlResult != null) {
                record.setTranscription(mlResult.transcript());
                record.setMoodType(mlResult.overall_mood());
                record.setConfidence(mlResult.confidence());
                record.setIsLowConfidence(mlResult.is_low_confidence());
                record.setCrisisDetected(mlResult.crisis_detected());
                record.setCrisisMessage(mlResult.crisis_message());
                record.setMoodArtBase64(mlResult.mood_art_base64());

                if (mlResult.emotions() != null) {
                    record.setCalmScore(mlResult.emotions().getOrDefault("calm", 0.0));
                    record.setJoyScore(mlResult.emotions().getOrDefault("joy", 0.0));
                    record.setSadnessScore(mlResult.emotions().getOrDefault("sadness", 0.0));
                    record.setStressScore(mlResult.emotions().getOrDefault("stress", 0.0));
                }
            }

            VoiceRecord saved = voiceRecordRepository.save(record);

            return ResponseEntity.ok(Map.of(
                    "message", "Аудіо збережено та проаналізовано!",
                    "status", "success",
                    "recordId", saved.getId().toString(),
                    "record", saved
            ));

        } catch (Exception e) {
            System.err.println("Помилка завантаження або ML-аналізу: " + e.getMessage());
            return ResponseEntity.internalServerError().body(Map.of(
                    "message", "Помилка сервера: " + e.getMessage(),
                    "status", "error"
            ));
        }
    }

    @GetMapping("/play/{id}")
    public ResponseEntity<Resource> playAudio(@PathVariable Long id) {
        try {
            VoiceRecord record = voiceRecordRepository.findById(id)
                    .orElseThrow(() -> new RuntimeException("Запис не знайдено"));

            // Если файл в Cloudinary — перенаправляем плеер браузера на прямой URL
            if (record.getFilePath().startsWith("http://") || record.getFilePath().startsWith("https://")) {
                return ResponseEntity.status(HttpStatus.FOUND)
                        .location(URI.create(record.getFilePath()))
                        .build();
            }

            Path filePath = Paths.get(record.getFilePath());
            Resource resource = new UrlResource(filePath.toUri());
            if (!resource.exists()) {
                return ResponseEntity.notFound().build();
            }

            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType("audio/webm"))
                    .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + resource.getFilename() + "\"")
                    .body(resource);

        } catch (Exception e) {
            System.err.println("Помилка відтворення: " + e.getMessage());
            return ResponseEntity.internalServerError().build();
        }
    }

    @GetMapping("/history")
    public ResponseEntity<?> getUserHistory(@RequestParam String email) {
        try {
            List<VoiceRecord> records = voiceRecordRepository.findByUserEmailOrderByCreatedAtDesc(email);
            return ResponseEntity.ok(records);
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("message", "Помилка отримання історії: " + e.getMessage()));
        }
    }

    @DeleteMapping("/delete/{id}")
    public ResponseEntity<?> deleteAudio(@PathVariable Long id) {
        try {
            VoiceRecord record = voiceRecordRepository.findById(id)
                    .orElseThrow(() -> new RuntimeException("Запис не знайдено"));

            if (record.getCloudinaryPublicId() != null) {
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
}