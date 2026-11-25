package com.moodvoice.api.dto;

import java.util.Map;

public record MlAnalysisResponse(
        String transcript,
        Map<String, Double> emotions,
        Map<String, Double> text_emotions,
        Map<String, Double> audio_emotions,
        String overall_mood,
        Double confidence,
        Boolean is_low_confidence,
        Boolean crisis_detected,
        String crisis_message,
        Double processing_time_sec
) {}