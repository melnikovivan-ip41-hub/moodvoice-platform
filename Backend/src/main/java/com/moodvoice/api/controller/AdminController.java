package com.moodvoice.api.controller;

import com.moodvoice.api.entity.User;
import com.moodvoice.api.entity.VoiceRecord;
import com.moodvoice.api.repository.UserRepository;
import com.moodvoice.api.repository.VoiceRecordRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/admin")
@CrossOrigin(origins = "*")
public class AdminController {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private VoiceRecordRepository voiceRecordRepository;

    @GetMapping("/users")
    public ResponseEntity<?> getAllUsers() {
        var users = userRepository.findAll().stream()
                .map(user -> {
                    Map<String, Object> dto = new LinkedHashMap<>();
                    dto.put("id", user.getId());
                    dto.put("email", user.getEmail());
                    dto.put("role", user.getRole());
                    dto.put("blocked", user.isBlocked());
                    dto.put("createdAt", user.getCreatedAt());
                    dto.put("recordsCount", voiceRecordRepository.countByUserEmail(user.getEmail()));
                    return dto;
                })
                .toList();

        return ResponseEntity.ok(users);
    }

    @PatchMapping("/users/{id}/block")
    public ResponseEntity<?> toggleBlockUser(
            @PathVariable Long id,
            @RequestBody(required = false) Map<String, Boolean> body,
            Authentication authentication) {

        User target = userRepository.findById(id)
                .orElseThrow(() -> new RuntimeException("Користувача не знайдено"));

        if (target.getEmail().equalsIgnoreCase(authentication.getName())) {
            return ResponseEntity.badRequest().body(Map.of(
                    "status", "error",
                    "message", "Неможливо заблокувати власний акаунт адміністратора"
            ));
        }

        boolean nextBlocked = (body != null && body.containsKey("blocked"))
                ? Boolean.TRUE.equals(body.get("blocked"))
                : !target.isBlocked();

        target.setBlocked(nextBlocked);
        userRepository.save(target);

        return ResponseEntity.ok(Map.of(
                "status", "success",
                "id", target.getId(),
                "email", target.getEmail(),
                "blocked", target.isBlocked(),
                "message", nextBlocked ? "Користувача заблоковано" : "Користувача розблоковано"
        ));
    }

    @GetMapping("/metrics")
    public ResponseEntity<?> getAggregatedMetrics() {
        List<User> users = userRepository.findAll();
        List<VoiceRecord> records = voiceRecordRepository.findAll();

        long blockedUsers = users.stream().filter(User::isBlocked).count();
        long crisisRecords = voiceRecordRepository.countByCrisisDetectedTrue();

        Map<String, Long> moodCounts = new HashMap<>();
        double calmSum = 0, joySum = 0, sadnessSum = 0, stressSum = 0;
        int scoredCount = 0;

        for (VoiceRecord r : records) {
            String mood = (r.getMoodType() == null || r.getMoodType().isBlank()) ? "Невідомо" : r.getMoodType();
            moodCounts.merge(mood, 1L, Long::sum);

            if (r.getCalmScore() != null) {
                calmSum += r.getCalmScore();
                joySum += r.getJoyScore() != null ? r.getJoyScore() : 0.0;
                sadnessSum += r.getSadnessScore() != null ? r.getSadnessScore() : 0.0;
                stressSum += r.getStressScore() != null ? r.getStressScore() : 0.0;
                scoredCount++;
            }
        }

        Map<String, Double> avgEmotions = new LinkedHashMap<>();
        if (scoredCount > 0) {
            avgEmotions.put("calm", Math.round((calmSum / scoredCount) * 1000.0) / 1000.0);
            avgEmotions.put("joy", Math.round((joySum / scoredCount) * 1000.0) / 1000.0);
            avgEmotions.put("sadness", Math.round((sadnessSum / scoredCount) * 1000.0) / 1000.0);
            avgEmotions.put("stress", Math.round((stressSum / scoredCount) * 1000.0) / 1000.0);
        }

        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("totalUsers", users.size());
        metrics.put("blockedUsers", blockedUsers);
        metrics.put("totalRecords", records.size());
        metrics.put("crisisRecords", crisisRecords);
        metrics.put("moodDistribution", moodCounts);
        metrics.put("averageEmotions", avgEmotions);

        return ResponseEntity.ok(metrics);
    }
}