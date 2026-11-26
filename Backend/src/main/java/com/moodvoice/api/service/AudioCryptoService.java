package com.moodvoice.api.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

@Service
public class AudioCryptoService {

    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_LENGTH_BYTES = 12;
    private static final int GCM_TAG_LENGTH_BITS = 128;

    private final SecretKey secretKey;
    private final SecureRandom secureRandom = new SecureRandom();

    public AudioCryptoService(@Value("${app.aes.secret-key}") String rawKey) {
        this.secretKey = buildAes256Key(rawKey);
    }

    private SecretKey buildAes256Key(String rawKey) {
        try {
            byte[] keyBytes;
            try {
                byte[] decoded = Base64.getDecoder().decode(rawKey.trim());
                keyBytes = (decoded.length == 32)
                        ? decoded
                        : MessageDigest.getInstance("SHA-256").digest(rawKey.getBytes(StandardCharsets.UTF_8));
            } catch (IllegalArgumentException e) {
                keyBytes = MessageDigest.getInstance("SHA-256").digest(rawKey.getBytes(StandardCharsets.UTF_8));
            }
            return new SecretKeySpec(keyBytes, "AES");
        } catch (Exception e) {
            throw new IllegalStateException("Не вдалося ініціалізувати ключ AES-256", e);
        }
    }

    public byte[] encrypt(byte[] plainAudio) {
        try {
            byte[] iv = new byte[IV_LENGTH_BYTES];
            secureRandom.nextBytes(iv);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            byte[] cipherText = cipher.doFinal(plainAudio);

            byte[] result = new byte[IV_LENGTH_BYTES + cipherText.length];
            System.arraycopy(iv, 0, result, 0, IV_LENGTH_BYTES);
            System.arraycopy(cipherText, 0, result, IV_LENGTH_BYTES, cipherText.length);
            return result;
        } catch (Exception e) {
            throw new RuntimeException("Помилка AES-256 шифрування аудіо", e);
        }
    }

    public byte[] decrypt(byte[] encryptedData) {
        if (encryptedData == null || encryptedData.length <= IV_LENGTH_BYTES) {
            throw new IllegalArgumentException("Пошкоджений зашифрований файл");
        }
        try {
            byte[] iv = new byte[IV_LENGTH_BYTES];
            System.arraycopy(encryptedData, 0, iv, 0, IV_LENGTH_BYTES);

            int cipherLength = encryptedData.length - IV_LENGTH_BYTES;
            byte[] cipherText = new byte[cipherLength];
            System.arraycopy(encryptedData, IV_LENGTH_BYTES, cipherText, 0, cipherLength);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, secretKey, new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
            return cipher.doFinal(cipherText);
        } catch (Exception e) {
            throw new RuntimeException("Помилка AES-256 дешифрування аудіо", e);
        }
    }
}