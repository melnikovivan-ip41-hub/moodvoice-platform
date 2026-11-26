package com.moodvoice.api.repository;

import com.moodvoice.api.entity.VoiceRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface VoiceRecordRepository extends JpaRepository<VoiceRecord, Long> {
    List<VoiceRecord> findByUserEmailOrderByCreatedAtDesc(String userEmail);
    long countByUserEmail(String userEmail);
    long countByCrisisDetectedTrue();
}