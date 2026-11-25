package com.moodvoice.api.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "records")
public class VoiceRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String userEmail;

    @Column(nullable = false)
    private String filePath;

    private String cloudinaryPublicId;

    private String moodType;

    @Column(columnDefinition = "TEXT")
    private String transcription;

    private Double calmScore;
    private Double joyScore;
    private Double sadnessScore;
    private Double stressScore;

    private Double confidence;
    private Boolean isLowConfidence;
    private Boolean crisisDetected;

    @Column(columnDefinition = "TEXT")
    private String crisisMessage;

    private LocalDateTime createdAt;
    private Long fileSize;

    public VoiceRecord() {}

    public VoiceRecord(String userEmail, String filePath, Long fileSize) {
        this.userEmail = userEmail;
        this.filePath = filePath;
        this.fileSize = fileSize;
        this.createdAt = LocalDateTime.now();
    }

    public Long getId() { return id; }
    public String getUserEmail() { return userEmail; }
    public void setUserEmail(String userEmail) { this.userEmail = userEmail; }
    public String getFilePath() { return filePath; }
    public void setFilePath(String filePath) { this.filePath = filePath; }
    public String getCloudinaryPublicId() { return cloudinaryPublicId; }
    public void setCloudinaryPublicId(String cloudinaryPublicId) { this.cloudinaryPublicId = cloudinaryPublicId; }
    public String getMoodType() { return moodType; }
    public void setMoodType(String moodType) { this.moodType = moodType; }
    public String getTranscription() { return transcription; }
    public void setTranscription(String transcription) { this.transcription = transcription; }
    public Double getCalmScore() { return calmScore; }
    public void setCalmScore(Double calmScore) { this.calmScore = calmScore; }
    public Double getJoyScore() { return joyScore; }
    public void setJoyScore(Double joyScore) { this.joyScore = joyScore; }
    public Double getSadnessScore() { return sadnessScore; }
    public void setSadnessScore(Double sadnessScore) { this.sadnessScore = sadnessScore; }
    public Double getStressScore() { return stressScore; }
    public void setStressScore(Double stressScore) { this.stressScore = stressScore; }
    public Double getConfidence() { return confidence; }
    public void setConfidence(Double confidence) { this.confidence = confidence; }
    public Boolean getIsLowConfidence() { return isLowConfidence; }
    public void setIsLowConfidence(Boolean isLowConfidence) { this.isLowConfidence = isLowConfidence; }
    public Boolean getCrisisDetected() { return crisisDetected; }
    public void setCrisisDetected(Boolean crisisDetected) { this.crisisDetected = crisisDetected; }
    public String getCrisisMessage() { return crisisMessage; }
    public void setCrisisMessage(String crisisMessage) { this.crisisMessage = crisisMessage; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public Long getFileSize() { return fileSize; }
}