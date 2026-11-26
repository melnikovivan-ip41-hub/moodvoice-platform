package com.moodvoice.api.controller;

import com.cloudinary.Cloudinary;
import com.cloudinary.utils.ObjectUtils;
import com.moodvoice.api.entity.User;
import com.moodvoice.api.entity.VoiceRecord;
import com.moodvoice.api.repository.UserRepository;
import com.moodvoice.api.repository.VoiceRecordRepository;
import com.moodvoice.api.security.JwtService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/auth")
@CrossOrigin(origins = "*")
public class AuthController {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private VoiceRecordRepository voiceRecordRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private JwtService jwtService;

    @Autowired(required = false)
    private Cloudinary cloudinary;

    @PostMapping("/register")
    public ResponseEntity<?> registerAnonymous(@RequestBody AuthRequest request) {
        String email = request.getEmail() == null ? "" : request.getEmail().trim().toLowerCase();
        String password = request.getPassword() == null ? "" : request.getPassword();

        if (!email.matches("^[a-z0-9._-]{6,30}@(gmail\\.com|ukr\\.net|kpi\\.ua|student\\.kpi\\.ua)$")) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Невірний формат пошти. Логін (до @) має бути від 6 до 30 символів. Дозволені домени: @gmail.com, @ukr.net, @kpi.ua",
                    "status", "error"
            ));
        }

        if (!password.matches("^[a-zA-Z0-9]{8,}$")) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Пароль має містити мінімум 8 символів (лише англійські літери та цифри).",
                    "status", "error"
            ));
        }

        if (userRepository.findByEmail(email).isPresent()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "message", "Email вже зайнятий",
                    "status", "error"
            ));
        }

        User newUser = new User(email, passwordEncoder.encode(password));
        userRepository.save(newUser);

        String token = jwtService.generateToken(newUser.getEmail(), newUser.getRole());

        return ResponseEntity.ok(Map.of(
                "message", "Успішна реєстрація",
                "status", "success",
                "token", token,
                "email", newUser.getEmail(),
                "role", newUser.getRole()
        ));
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody AuthRequest request) {
        String email = request.getEmail() == null ? "" : request.getEmail().trim().toLowerCase();
        String rawPassword = request.getPassword() == null ? "" : request.getPassword();

        Optional<User> userOpt = userRepository.findByEmail(email);
        if (userOpt.isEmpty()) {
            return ResponseEntity.status(401).body(Map.of(
                    "message", "Невірні дані",
                    "status", "error"
            ));
        }

        User user = userOpt.get();
        if (user.isBlocked()) {
            return ResponseEntity.status(403).body(Map.of(
                    "message", "Акаунт заблоковано адміністратором",
                    "status", "error"
            ));
        }

        String storedPassword = user.getPassword() == null ? "" : user.getPassword();
        boolean isBcryptHash = storedPassword.startsWith("$2a$")
                || storedPassword.startsWith("$2b$")
                || storedPassword.startsWith("$2y$");

        boolean passwordValid;
        if (isBcryptHash) {
            passwordValid = passwordEncoder.matches(rawPassword, storedPassword);
        } else {
            // Автоматична міграція старих паролів на BCrypt при першому вході
            passwordValid = storedPassword.equals(rawPassword);
            if (passwordValid) {
                user.setPassword(passwordEncoder.encode(rawPassword));
                userRepository.save(user);
            }
        }

        if (!passwordValid) {
            return ResponseEntity.status(401).body(Map.of(
                    "message", "Невірні дані",
                    "status", "error"
            ));
        }

        String token = jwtService.generateToken(user.getEmail(), user.getRole());

        return ResponseEntity.ok(Map.of(
                "message", "Вхід успішний",
                "status", "success",
                "token", token,
                "email", user.getEmail(),
                "role", user.getRole()
        ));
    }

    @GetMapping("/me")
    public ResponseEntity<?> currentUser(Authentication authentication) {
        User user = userRepository.findByEmail(authentication.getName())
                .orElseThrow(() -> new RuntimeException("Користувача не знайдено"));

        return ResponseEntity.ok(Map.of(
                "id", user.getId(),
                "email", user.getEmail(),
                "role", user.getRole(),
                "recordsCount", voiceRecordRepository.countByUserEmail(user.getEmail())
        ));
    }

    @DeleteMapping("/account")
    public ResponseEntity<?> deleteOwnAccount(Authentication authentication) {
        String email = authentication.getName();
        User user = userRepository.findByEmail(email)
                .orElseThrow(() -> new RuntimeException("Користувача не знайдено"));

        List<VoiceRecord> records = voiceRecordRepository.findByUserEmailOrderByCreatedAtDesc(email);
        for (VoiceRecord record : records) {
            try {
                if (record.getCloudinaryPublicId() != null && cloudinary != null) {
                    cloudinary.uploader().destroy(
                            record.getCloudinaryPublicId(),
                            ObjectUtils.asMap("resource_type", "video")
                    );
                } else if (record.getFilePath() != null
                        && !record.getFilePath().startsWith("http://")
                        && !record.getFilePath().startsWith("https://")) {
                    Files.deleteIfExists(Paths.get(record.getFilePath()));
                }
            } catch (Exception ignored) {}
        }

        voiceRecordRepository.deleteAll(records);
        userRepository.delete(user);

        return ResponseEntity.ok(Map.of(
                "status", "success",
                "message", "Акаунт та всі зашифровані записи повністю видалено"
        ));
    }
}

class AuthRequest {
    private String email;
    private String password;
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }
}