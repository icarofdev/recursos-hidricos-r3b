# Guia de Deploy em Produção — VPS Ubuntu / Debian

Passo a passo conciso para publicar o **Recursos Hídricos R3B** em uma VPS Linux limpa (Ubuntu 22.04 / 24.04 ou Debian 12), eliminando totalmente a dependência do PC local.

---

## 1. Arquitetura em Produção

```text
SM-WU V5.10 ──HTTP:80 (/api/device/ingest.php?token=...)──► Nginx (VPS) ──► PHP-FPM ──► MariaDB
Navegador   ──HTTPS:443 (Dashboard / Consultas)────────► Nginx (VPS) ──► PHP-FPM ──► MariaDB
```

- **SM-WU**: Envia HTTP direto para a VPS. O PC fica 100% desligado/livre.
- **Nginx**: Aceita HTTP apenas na rota de ingestão; força HTTPS para todo o resto.
- **MariaDB**: Acessível estritamente em `127.0.0.1`.
- **Custo**: 1 única VPS básica (ex: 1 vCPU / 1GB RAM) sem serviços externos pagos.

---

## 2. Instalação dos Pacotes

Acesse a VPS via SSH como `root` e execute:

```bash
apt update && apt upgrade -y
apt install -y nginx mariadb-server php-fpm php-mysql php-curl php-mbstring php-xml unzip git ufw logrotate certbot python3-certbot-nginx
```

---

## 3. Usuário Dedicado 'deploy', SSH por Chave e Sudoers Mínimo

Para máxima segurança, não execute deploys diários como `root` e não utilize senhas:

```bash
# 1. Criar usuário sem privilégios 'deploy' e adicioná-lo ao grupo www-data
adduser --gecos "" --disabled-password deploy
usermod -aG www-data deploy

# 2. Configurar sua chave pública SSH para o usuário deploy
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
# Cole sua chave pública (ex: conteúdo do seu id_ed25519.pub):
echo "ssh-ed25519 AAAA... seu_email@exemplo.com" > /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

# 3. Configurar sudoers com privilégio mínimo (apenas reload e testes Nginx/PHP-FPM)
cp deploy/sudoers/recursos-hidricos /etc/sudoers.d/recursos-hidricos-deploy
chmod 440 /etc/sudoers.d/recursos-hidricos-deploy

# 4. Desabilitar login de root e senhas no SSH (/etc/ssh/sshd_config)
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

---

## 4. Configuração do Firewall (UFW)

Feche todas as portas não utilizadas:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH       # Porta 22
ufw allow 80/tcp        # HTTP (Ingestão SM-WU + Let's Encrypt)
ufw allow 443/tcp       # HTTPS (Dashboard / Admin)
ufw --force enable
```

> **Atenção:** A porta 3306 do MariaDB **NÃO** deve ser aberta no firewall.

---

## 4. Banco de Dados MariaDB

```bash
# Inicialize o banco seguro (opcional no MariaDB moderno)
sudo mysql_secure_installation

# Crie a base e o usuário restrito ao localhost (usando sudo mysql via socket local)
sudo mysql <<EOF
CREATE DATABASE IF NOT EXISTS recursos_hidricos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'recursos_user'@'127.0.0.1' IDENTIFIED BY 'SUA_SENHA_FORTE_DO_BANCO';
GRANT ALL PRIVILEGES ON recursos_hidricos.* TO 'recursos_user'@'127.0.0.1';
FLUSH PRIVILEGES;
EOF
```

---

## 5. Código e Permissões

Clone o repositório no diretório web da VPS:

```bash
mkdir -p /var/www
cd /var/www
git clone <URL_DO_SEU_REPOSITORIO> recursos-hidricos-r3b
cd recursos-hidricos-r3b

# Importar schema
mysql -u recursos_user -p'SUA_SENHA_FORTE_DO_BANCO' -h 127.0.0.1 recursos_hidricos < database/schema.sql

# Configurar ambiente
cp .env.example .env
nano .env   # Ajuste DB_PASSWORD, DEVICE_TOKEN_SECRET, etc.

# Permissões seguras
chown -R www-data:www-data /var/www/recursos-hidricos-r3b
chmod -R 755 /var/www/recursos-hidricos-r3b
chmod 600 /var/www/recursos-hidricos-r3b/.env
chmod +x /var/www/recursos-hidricos-r3b/scripts/*.sh
```

### Sincronização Contínua a partir da sua Máquina Local

Para subir atualizações do seu PC direto para a VPS sem precisar de git push manual ou expor credenciais:

1. Configure as variáveis de conexão:
```powershell
cp deploy/vps.env.example deploy/vps.env
# Preencha VPS_HOST, VPS_USER, etc. no deploy/vps.env
```

2. Execute o script correspondente:
- **No Windows (PowerShell)**:
  ```powershell
  .\deploy\sync-vps.ps1
  ```
- **No Linux / macOS / Git Bash**:
  ```bash
  ./deploy/sync-vps.sh
  ```

*(O script nunca sobrescreve o `.env` da VPS, ajusta permissões e recarrega os serviços automaticamente).*

---

## 6. Configurar Nginx e HTTPS

1. Copie o arquivo de configuração:
```bash
cp deploy/nginx/recursos-hidricos.conf /etc/nginx/sites-available/recursos-hidricos
# Ajuste o server_name e o socket PHP (ex: /run/php/php8.2-fpm.sock)
nano /etc/nginx/sites-available/recursos-hidricos

ln -s /etc/nginx/sites-available/recursos-hidricos /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

2. Obtenha o certificado SSL Let's Encrypt protegendo a regra da porta 80:
```bash
# NUNCA use redirecionamento automático do Certbot (isso removeria a exceção do medidor na porta 80).
# O comando abaixo emite os certificados sem alterar nenhuma linha do Nginx:
certbot certonly --webroot -w /var/www/html -d seudominio.com.br
# (OU se preferir o plugin nginx: certbot --nginx --no-redirect -d seudominio.com.br)

systemctl reload nginx
```
*(O modo `certonly --webroot` valida através do desafio em `/.well-known/acme-challenge/` já liberado na porta 80. O Certbot salvará os certificados exatamente no caminho esperado pelo Nginx e as renovações automáticas futuras NUNCA alterarão a exceção do SM-WU).*

---

## 7. Rotinas Automáticas (Backup e Retenção)

```bash
# Copie a configuração do cron
cp deploy/cron/recursos-hidricos /etc/cron.d/recursos-hidricos
chmod 644 /etc/cron.d/recursos-hidricos

# Crie a pasta de backups
mkdir -p /var/backups/recursos-hidricos
chmod 700 /var/backups/recursos-hidricos
```

---

## 8. Configuração no Firmware SM-WU V5.10

No painel de configuração do aparelho SM-WU:

- **Tipo de Envio**: `Padrão`
- **Protocolo**: `POST`
- **Servidor**: `IP_OU_DOMINIO_DA_VPS`
- **Porta**: `80`
- **Caminho**: `/api/device/ingest.php?token=SEU_DEVICE_TOKEN_SECRET`

---

## 9. Como Testar e Validar

1. **Testar Healthcheck**:
```bash
curl -I http://127.0.0.1/health.php
# Deve retornar HTTP 200 {"status":"ok","database":"connected"}
```

2. **Simular Envio do SM-WU**:
```bash
curl -X POST "http://IP_DA_VPS/api/device/ingest.php?token=SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":1,"distancia":42.5,"nivel":75.0,"volume":1253.0,"rssi_wifi":-60.0}'
# Deve retornar: {"success":true,"data":{"id":1}}
```

3. **Verificar Leitura no Dashboard**:
Abra `https://seudominio.com.br` no navegador e confirme a atualização em tempo real.
