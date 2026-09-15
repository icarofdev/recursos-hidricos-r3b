<?php

declare(strict_types=1);

require_once __DIR__ . '/config/bootstrap.php';
require_once APP_ROOT . '/config/database.php';
require_once APP_ROOT . '/includes/auth.php';
if (auth_current_user() !== null) { header('Location: /', true, 302); exit; }
web_security_headers();
$escape = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
?>
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b2638"><meta name="csrf-token" content="<?= $escape(auth_csrf_token()) ?>"><title>Recuperar senha — Hidra R3B</title><link rel="stylesheet" href="/static/css/auth.css"><script defer src="/static/js/auth.js"></script></head>
<body><main class="auth-layout"><section class="auth-brand-panel"><a class="auth-brand" href="/" aria-label="Hidra R3B"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2S5.5 9 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 9 12 2 12 2Z"/></svg></span><strong>Hidra <b>R3B</b></strong></a><div><p class="eyebrow">Recuperação segura</p><h1>Volte ao monitoramento.</h1><p>Enviaremos um link de uso único, com validade curta, para o e-mail da conta.</p></div></section><section class="auth-form-panel"><div class="auth-card"><div class="mobile-brand">Hidra <b>R3B</b></div><a class="back-link" href="/login">← Voltar para o login</a><p class="eyebrow">Segurança da conta</p><h2>Esqueceu sua senha?</h2><p class="auth-subtitle">Informe o e-mail cadastrado. A resposta será enviada de forma segura.</p><form class="auth-form" id="forgot-form" data-endpoint="/api/auth/forgot-password.php" data-success="message"><label><span>E-mail</span><input name="email" type="email" maxlength="254" autocomplete="email" placeholder="voce@empresa.com" required></label><p class="form-error" data-form-error role="alert"></p><div class="success-panel" data-success-panel hidden><strong>Confira seu e-mail</strong><p data-success-message></p><a href="/login">Voltar para o login</a></div><button class="auth-submit" type="submit"><span>Enviar instruções</span><span class="button-loader" aria-hidden="true"></span></button></form></div><p class="auth-footer">Por segurança, não informamos se um e-mail está cadastrado.</p></section></main></body></html>
