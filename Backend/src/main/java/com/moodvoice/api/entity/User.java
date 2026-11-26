package com.moodvoice.api.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "users")
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(unique = true, nullable = false)
    private String email;

    private String password;

    private String role = "USER";

    private Boolean blocked = false;

    private LocalDateTime createdAt;

    public User() {}

    public User(String email, String password) {
        this.email = email;
        this.password = password;
        this.role = "USER";
        this.blocked = false;
        this.createdAt = LocalDateTime.now();
    }

    public Long getId() { return id; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }

    public String getRole() {
        return (role == null || role.isBlank()) ? "USER" : role;
    }
    public void setRole(String role) { this.role = role; }

    public boolean isBlocked() {
        return Boolean.TRUE.equals(blocked);
    }
    public void setBlocked(Boolean blocked) { this.blocked = blocked; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}