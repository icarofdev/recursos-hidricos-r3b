<?php

declare(strict_types=1);

require_once __DIR__ . '/config/bootstrap.php';
require_once APP_ROOT . '/config/database.php';
require_once APP_ROOT . '/includes/auth.php';

if (auth_current_user() !== null) {
    header('Location: /', true, 302);
    exit;
}
web_security_headers();
$next = auth_safe_path(isset($_GET['next']) && is_string($_GET['next']) ? $_GET['next'] : '/');
$escape = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
?>
<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b2638"><meta name="csrf-token" content="<?= $escape(auth_csrf_token()) ?>"><title>Entrar — Hidra R3B</title><link rel="stylesheet" href="/static/css/auth.css"><script defer src="/static/js/auth.js"></script></head>
<body><main class="auth-layout"><section class="auth-brand-panel"><a class="auth-brand" href="/" aria-label="Hidra R3B"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2S5.5 9 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 9 12 2 12 2Z"/></svg></span><strong>Hidra <b>R3B</b></strong></a><div><p class="eyebrow">Central de Monitoramento</p><h1>Seus reservatórios, sob controle.</h1><p>Telemetria confiável, alertas claros e histórico seguro em uma única plataforma.</p></div><div class="brand-feature"><span>●</span><p><strong>Monitoramento contínuo</strong><small>Dados do seu dispositivo com acesso isolado por conta.</small></p></div></section>
<section class="auth-form-panel"><div class="auth-card"><div class="mobile-brand">Hidra <b>R3B</b></div><p class="eyebrow">Bem-vindo de volta</p><h2>Entre na sua conta</h2><p class="auth-subtitle">Acesse sua central de monitoramento.</p><div class="success-banner" id="reset-success" hidden>Senha alterada. Entre com sua nova senha.</div><form class="auth-form" id="login-form" data-endpoint="/api/auth/login.php" data-success="redirect"><input type="hidden" name="next" value="<?= $escape($next) ?>"><label><span>E-mail</span><input name="email" type="email" maxlength="254" autocomplete="email" placeholder="voce@empresa.com" required></label><label><span>Senha</span><input name="password" type="password" maxlength="128" autocomplete="current-password" placeholder="Sua senha" required></label><div class="form-options"><label class="check-field"><input name="remember" type="checkbox"><span>Lembrar de mim</span></label><a href="/esqueci-senha">Esqueci minha senha</a></div><p class="form-error" data-form-error role="alert"></p><button class="auth-submit" type="submit"><span>Entrar</span><span class="button-loader" aria-hidden="true"></span></button></form><p class="auth-switch">Ainda não tem uma conta? <a href="/cadastro">Criar conta</a></p></div><p class="auth-footer">© <?= date('Y') ?> Hidra R3B · Conexão protegida</p></section></main></body></html>
