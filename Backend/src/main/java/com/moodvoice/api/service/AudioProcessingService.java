package com.moodvoice.api.service;

import com.moodvoice.api.dto.MlAnalysisResponse;
import com.moodvoice.api.entity.VoiceRecord;
import com.moodvoice.api.repository.VoiceRecordRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.Arrays;

@Service
public class AudioProcessingService {

    @Autowired
    private VoiceRecordRepository voiceRecordRepository;

    @Autowired
    private MlServiceClient mlServiceClient;

    @Async
    public void processAudioAsync(Long recordId, byte[] audioBytes, String originalFilename) {
        try {
            VoiceRecord record = voiceRecordRepository.findById(recordId).orElse(null);
            if (record == null) return;

            MlAnalysisResponse mlResult = mlServiceClient.analyzeAudio(audioBytes, originalFilename);

            if (mlResult == null) {
                throw new RuntimeException("ML-сервіс повернув порожню відповідь");
            }

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

            record.setStatus("COMPLETED");
            voiceRecordRepository.save(record);

        } catch (Exception e) {
            System.err.println("Помилка фонового ML-аналізу для запису #" + recordId + ": " + e.getMessage());
            voiceRecordRepository.findById(recordId).ifPresent(rec -> {
                rec.setStatus("FAILED");
                voiceRecordRepository.save(rec);
            });
        } finally {
            if (audioBytes != null) {
                Arrays.fill(audioBytes, (byte) 0);
            }
        }
    }
}