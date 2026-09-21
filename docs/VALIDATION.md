# Relatório de migração e validação local

Data: 15/09/2026. Não houve deploy nem envio de e-mails reais.

## Implementado

- Cinco páginas preservadas em templates HTML independentes do PHP.
- Dezesseis endpoints de negócio e saúde portados para TypeScript/Pages.
- Snapshot agregado, CSRF, sessões D1 com rotação e expiração, lembrar de mim.
- Cadastro, login/logout, hash com salt/pepper e limites por IP/identidade.
- Recuperação via API Brevo, token SHA-256, validade fixa de 20 minutos,
  consumo atômico, revogação das sessões/tokens anteriores e URL pública HTTPS.
- Pareamento atômico, renomeação/desvinculação, consultas isoladas por proprietário.
- Ingestão HTTPS opcional com credencial individual por dispositivo.
- Compartilhamento opcional HTTP Basic somente leitura, preservando a restrição
  mesmo quando o cookie é reutilizado no modo normal.
- Interface de integração Monitorie, erros controlados, cache positivo/negativo,
  filtragem de histórico por vínculo e simulação restrita ao desenvolvimento local.
- Migrations completas, build com allowlist, secrets locais novos, comandos D1,
  provisionamento administrativo e instruções de publicação em Pages.
- Código/infraestrutura PHP legados preservados fora do artefato de publicação.

## Verificação automatizada

`npm run check`: TypeScript sem erros, build concluído e **17 testes aprovados**.
Executados no runtime workerd via Miniflare com D1 efêmero, aplicando as migrations
reais. A saída externa de e-mail foi interceptada; nenhuma conta externa usada.

1. Banco inicialmente vazio, migrations completas e cinco páginas.
2. Cadastro, hash/salt, cookie seguro, CSRF e logout.
3. Login, lembrar de mim, redirect interno e bloqueio de origem externa.
4. Expiração absoluta/inativa e rotação de sessão.
5. APIs privadas, métodos e validação de entrada.
6. Logout concorrente à rotação de sessão.
7. Rate limit persistente de login e Retry-After.
8. Contrato Brevo simulado, hash do token, URL pública e 20 minutos.
9. Dois resets concorrentes: somente um aceito; todas as sessões revogadas.
10. Token expirado e invalidação quando o envio falha.
11. Dois pareamentos concorrentes, isolamento entre contas e histórico preservado.
12. Monitorie sem configuração: erro controlado/cache negativo, conta acessível.
13. Ingestão autenticada, aliases do firmware e faixas físicas.
14. Mock recusado em URL pública; snapshot reutilizado pelo cache local.
15. URL de recuperação localhost rejeitada e e-mail desativado sem envio.
16. Compartilhamento Basic somente leitura, inclusive ao reutilizar o cookie.
17. Artefato sem PHP, arquivos de ambiente ou chaves utilizadas nos testes.

Também passaram a verificação de sintaxe dos dois scripts do frontend e
`git diff --check` (apenas avisos informativos LF/CRLF do Windows).

## Verificação do fluxo de desenvolvimento

- `npm run db:local`: migration aplicada via Wrangler em D1 local vazio, 24 comandos.
- `npm run dev:seed`: dispositivo mock provisionado com código aleatório/expirável.
- `npm run dev`: Pages/workerd respondendo em `http://127.0.0.1:8788`.
- Pelo navegador: cadastro de conta fictícia, onboarding, validação do código,
  vínculo do reservatório e dashboard com nível, volume, estado e histórico.
- Conferência visual em painel estreito: design responsivo preservado e faixa
  identificando dados simulados. Preview deixado aberto com essa conta local.

O preview contém somente uma conta fictícia e dispositivo simulado. Credenciais
reais, banco PHP existente e seus dados não foram importados nem modificados.
O `.env` legado permanece intacto; a execução Cloudflare não o carrega.

## Validação em Produção Concluída

1. **Monitor IE (Concluída):** Mapeamento e telemetria real validados para SM-WU (`d`, `nivel`, `volume`, `rssi_wifi`) e SM-WA (`vazao`, `consumo`, `rssi_wifi`). Modo `live` ativo, cache de 300 segundos e gate D1 de concorrência.
2. **Brevo (Pendente de Ativação Real):** `MAIL_MODE=disabled` mantido até fornecimento de chave definitiva e aprovação formal de envio real.
3. **Ingestão Direta:** Mantida desabilitada (`INGEST_ENABLED=false`).
4. **Banco D1 de Produção:** Limpo, sem contas ou dados sintéticos residuais. Apenas usuários e dispositivos reais autorizados.

## Arquivos de referência

- `docs/MIGRATION.md`: inventário e mapeamento completo antes/depois.
- `docs/CLOUDFLARE.md`: publicação, segurança, limites, backups e dados legados.
- `docs/MONITORIE.md`: contrato interno e informações a pedir à IE.
- `docs/LEGACY-PHP.md`: documentação anterior, preservada.

Alterações ficaram no workspace, sem commit automático, sem assinatura de plano
pago e sem apagar o backend/banco anteriores.
