# Operação e recuperação — schema 14

Este procedimento é para execução posterior por um operador autorizado. Nenhum backup,
alarme, DNS, migration remota ou publicação foi ativado pela correção local.

## Publicação e compatibilidade

O `vercel.json` mantém `git.deploymentEnabled=false` enquanto a publicação não estiver
autorizada. Pushes salvam o código sem disparar deploy automático pela integração Git
da Vercel. Reative essa opção somente quando as pendências de publicação estiverem
resolvidas; um deploy manual também exige autorização separada.

1. Reserve janela de manutenção; registre versão do Worker, versão do frontend e bookmark
   do D1. Mantenha exportação cifrada fora do repositório. Confirme que a restauração foi
   ensaiada e que um administrador dispõe de senha, autenticador e recuperação.
2. Aplique **0012_security_boundaries.sql**, **0013_telemetry_quality.sql** e depois
   **0014_audit_identity_configuration.sql** primeiro em banco descartável/staging, depois
   no ambiente escolhido. Preserve 0001–0011 e siga a ordem dos arquivos reais.
3. Publique Worker e frontend correspondentes ao schema 14. O novo Worker não deve
   receber tráfego antes das migrations. Durante a aplicação, bloqueie tráfego de usuários:
   o Worker antigo não implementa todas as novas fronteiras de autorização.
4. Configure `APP_URL` e `CORS_ORIGINS` com as origens HTTPS reais e exatas.
   O valor versionado de produção é o frontend canônico do projeto; preview precisa
   dos próprios valores. Não inferir bindings publicados a partir do arquivo local.
5. Configure Resend, domínio/remetente e `RESEND_API_KEY`. O binding correto é
   **EMAIL_FROM**, não MAIL_FROM. Defina `MAIL_MODE=resend` quando a recuperação for
   obrigatória. Exceção temporária autorizada pelo operador em 18/10/2026: produção
   mantém `MAIL_MODE=disabled` e `MAIL_REQUIRED=false`, com recuperação e envio de
   confirmação indisponíveis. Restaure `MAIL_REQUIRED=true` ao habilitar o provedor.
   Preview também pode manter e-mail opcional desativado.
6. Valide formato de `TOTP_ENCRYPTION_KEY`, `SESSION_SECRET` e `PASSWORD_PEPPER` sem
   copiar valores para logs. Confirme `/api/health` (liveness sem banco) e `/api/ready`
   (schema/configuração, sem chamadas ao Resend ou MonitorIE).
7. Teste login, confirmação, TOTP, compartilhamento, desligamento e mudança de titular
   em staging. Verifique cookies entre as origens reais nos navegadores suportados.
8. Confira no painel a execução do cron de limpeza **a cada minuto**, a rota efetiva
   da API e as regras de abuso que realmente a cobrem. Mantenha `INGEST_ENABLED=false`.

Não execute migrations reversas improvisadas. Depois da migration 0013, valores de
volume/nível podem ser nulos. Um rollback de código precisa manter as novas fronteiras
de segurança e suportar o schema 14; voltar ao Worker anterior a 0012 não é rollback
seguro. Restaurar dados é uma operação separada, com perda das mudanças posteriores ao
ponto escolhido. Após restaurar um backup antigo, reaplique e valide as migrations em
isolamento antes de liberar tráfego.

O schema 14 inclui `device_identities`, um registro permanente mínimo de ID, identidade
aleatória e data de criação, sem nomes, e-mails, MACs ou leituras. Inclua essa tabela em
backups e restaurações: seus tombstones impedem reutilizar IDs apagados, inclusive depois
de expirar a auditoria. A API aloca o próximo ID pelo registro durável; ferramentas de
provisionamento com IDs explícitos precisam escolher um ID novo. Não apague tombstones
para fazer uma operação passar. O Worker anterior ao schema 14 não possui esse allocator;
um rollback apenas de código pode falhar ao cadastrar dispositivos após exclusões.

Eventos anteriores à migration 0014 são apresentados com identidade histórica não
comprovada. Não se associa o código atual a um evento antigo que pode já ter sofrido
reutilização de ID. A migration preserva os registros e não tenta reconstruir evidência
ausente. A configuração do reservatório ganha uma versão monotônica conferida no batch
da alteração: conflitos retornam 409 e exigem recarregar os valores antes de tentar de novo.

## Identidade e administradores existentes

Contas existentes começam com `email_verified_at=NULL`. Seus vínculos de proprietário são
preservados. O acesso de membros fica suspenso até a confirmação, inclusive nos vínculos
antigos: manter acesso de um endereço pré-cadastrado por terceiro perpetuaria a falha.
O vínculo não é apagado; confirmação da mesma conta libera o acesso novamente.
Novas concessões de compartilhamento e novas promoções exigem confirmação.
O login dos administradores já existentes e seus autenticadores **não** são apagados.
O painel oferece envio de confirmação; o link só pode ser consumido em sessão autenticada
da mesma conta. Uma mensagem enviada para endereço cadastrado por terceiro não confirma
automaticamente a conta dele ao ser aberta pelo verdadeiro destinatário.

Se necessário, o titular recupera a conta pelo fluxo de senha e depois confirma o e-mail.
Não promova uma conta baseada somente no endereço alegado. O script `admin.mjs` e o
trigger do banco bloqueiam essa promoção.

Para uma conta administrativa existente sem acesso ao fluxo de e-mail, um operador deve
comprovar independentemente acesso à caixa postal e registrar a atestação **daquela
conta**, nunca de todas as contas. Ensaio local:

```sh
node scripts/cloudflare/attest-email.mjs USER_ID --attested
node scripts/cloudflare/admin.mjs set-admin ADDRESS
```

Para produção, após comprovação externa, execute em janela autorizada a atualização
condicional do único ID e registre `email_attested` em auditoria na mesma transação.
O procedimento não autoriza atestar um endereço apenas por a pessoa saber a senha ou
um TOTP; a prova precisa incluir a caixa postal. Não imprima nomes/e-mails no diagnóstico.

## Titularidade, leituras e firmware

`ownership_generation` sobrevive à exclusão da conta. Novos vínculos possuem geração
própria, fronteira temporal em milissegundos e cache separado. A exceção de primeira
ativação foi retirada: não há prova suficiente de primeira titularidade física após
exclusão/recriação de cadastro ou histórico legado. Nenhum proprietário ou membro herda
leituras anteriores ao acesso, inclusive no primeiro pareamento. Equipamentos MonitorIE
preexistentes com histórico incerto são marcados conservadoramente pela migration.
Autorização é conferida novamente após chamadas assíncronas e também em cache hits.

Desvinculação, transferência e novo pareamento revogam tokens de ingestão. Para recuperar
operação de equipamento local: confirme o novo vínculo; o administrador faz TOTP recente
e chama `POST /api/admin/devices/DEVICE_ID/rotate-token`; instale a credencial exibida uma
vez no firmware por canal seguro. Não copie para URL, logs ou repositório. O token antigo
deve retornar 401. Esta configuração continua desativada em produção até autorização
independente para habilitar ingestão.

Eventos em buffer anteriores à fronteira do novo vínculo retornam `EVENT_BEFORE_LINK`.
O firmware deve usar timestamp ISO UTC, preferencialmente com milissegundos, e um
`Idempotency-Key` estável por evento. Retransmitir o mesmo evento reutiliza a chave;
nova medição usa nova chave, mesmo com valores iguais. Sem timestamp/chave cada mensagem
é uma nova medição: o servidor não consegue provar que seja retransmissão. Um timestamp
com precisão de segundo pode ser anterior à ativação ocorrida naquele segundo.

Distância válida porém fora da geometria é registrada com volume/nível desconhecidos.
O ajuste no intervalo de tolerância já configurado é explícito (`within_tolerance`),
visível na API e no painel; distâncias além da tolerância não são ajustadas.
Comunicação autenticada é preservada sem inventar volume. Dados em cache, comunicação
confirmada e falha da integração são estados separados; `unknown` não gera alerta crítico
de equipamento offline. O intervalo global MonitorIE permanece 70 segundos; a fila
expira pedidos abandonados e distribui vagas entre dispositivos, sem aumentar consultas.

## Rotação preventiva e comprometimento

Versione cada chave com ID distinto (`TOTP_KEY_ID`, `PASSWORD_PEPPER_ID`). Existe no
máximo uma chave anterior por tipo, com deadline Unix UTC de até sete dias. Após o prazo
o Worker não a aceita. Remova também o binding do cofre/serviço ao encerrar a transição.

Prepare no cofre uma configuração completa: chave nova/ID novo, chave anterior/ID
anterior e deadline. Faça o corte **atômico** de IDs e valores numa nova versão do Worker;
não atualize esses bindings um a um sob tráfego. O Wrangler instalado oferece
`versions secret bulk` para preparar todos os bindings em uma versão sem a publicar.
Ensaie primeiro; confirme que a versão preparada não recebe tráfego até o corte.
Não coloque chaves em argumentos, saída do terminal ou arquivos versionados.

Exemplo para execução posterior pelo operador: prepare um JSON privado fora do checkout,
com permissões restritas e **todos** os bindings de transição; IDs/deadlines também podem
ser bindings secretos. Nunca use `.dev.vars` compartilhado ou copie o conteúdo para logs.

```sh
node scripts/cloudflare/wrangler.mjs versions secret bulk PRIVATE_JSON_PATH --name WORKER_NAME
node scripts/cloudflare/wrangler.mjs versions deploy VERSION_ID@100% --name WORKER_NAME
```

Revise o ID de versão devolvido pelo primeiro comando e a configuração antes do segundo.
O primeiro prepara; o segundo publica e exige autorização separada. Os comandos não foram
executados nesta tarefa. Se houver versão de código não publicada mais recente, confirme
explicitamente qual versão serviu de base; não promova código alheio inadvertidamente.

Bindings de transição:

```text
TOTP_ENCRYPTION_KEY, TOTP_KEY_ID
TOTP_ENCRYPTION_KEY_PREVIOUS, TOTP_KEY_PREVIOUS_ID, TOTP_KEY_PREVIOUS_UNTIL
PASSWORD_PEPPER, PASSWORD_PEPPER_ID
PASSWORD_PEPPER_PREVIOUS, PASSWORD_PEPPER_PREVIOUS_ID, PASSWORD_PEPPER_PREVIOUS_UNTIL
```

TOTP é recriptografado no login/reauth quando usa formato/chave anterior. O helper
`reencryptTotp` processa contas em páginas de 20, com comparação do ciphertext anterior
para não sobrescrever alteração concorrente. A ferramenta local recebe JSON privado,
sem echo, e não gera chaves:

```sh
node scripts/cloudflare/rotate-totp-local.mjs --local
```

Ensaie em cópia local do banco. Para migrar administradores inativos em produção, execute
o mesmo helper por ferramenta de operação autenticada e autorizada ao D1, ou mantenha
uma janela de reenrolamento com códigos de recuperação. Antes de retirar a chave anterior,
conte formatos/IDs antigos, sem imprimir ciphertexts. O helper local não restaura nem
altera serviços remotos automaticamente.

```sql
-- Substitua NEW_ID somente pelo identificador público da chave atual.
SELECT COUNT(*) AS remaining FROM admin_totp
WHERE secret_encrypted NOT LIKE 'v2.NEW_ID.%';
```

Administradores inativos que não foram recriptografados precisam ter recuperação disponível:
login com senha → opção de recuperação do autenticador → código de recuperação ainda
não usado → cadastrar novo autenticador → confirmar TOTP → guardar os novos códigos.
Sem chave anterior nem recuperação, será necessário um procedimento independente de
comprovação de identidade e reenrolamento, autorizado pelo operador. Não desative MFA
ou promova outra conta como atalho automático.

Senha não permite re-hash offline sem plaintext. Login com chave anterior válida faz
rehash para v2/chave atual e revoga sessões/desafios anteriores. Usuários inativos precisam
de recuperação de senha antes/depois do fim da janela; não mantenha fallback permanente.
Verifique recuperação e administração de e-mail antes de iniciar essa rotação.

Em comprometimento, não use uma longa transição de confiança: retire a chave exposta,
revogue sessões/desafios e faça recuperação/reenrolamento das contas afetadas. Não basta
recifrar TOTP se um segredo puder ter sido extraído. Mantenha recuperação independente
e auditoria. Uma falha parcial de recriptografia exige conservar backup e inventário das
contas restantes, não retornar todo o banco a um ponto antigo indiscriminadamente.

## Backups e restauração

Objetivos propostos, a validar com o operador: **RPO de 15 minutos e RTO de 60 minutos**
para recuperação operacional com Time Travel; exportação externa diária é defesa adicional
com RPO próprio de até 24 horas. Isso não comprova cumprimento desses objetivos.

Confira plano, acesso e janela do Time Travel no ambiente real. A documentação informa
até 7 dias no Free e 30 no Paid; restauração sobrescreve o banco e cancela operações em
curso. Registre o bookmark anterior para desfazer uma restauração autorizada.
[Referência oficial](https://developers.cloudflare.com/d1/reference/time-travel/).

Comandos de operação posteriores, sem execução nesta correção:

```sh
node scripts/cloudflare/wrangler.mjs d1 time-travel info hidra-r3b
node scripts/cloudflare/wrangler.mjs d1 export hidra-r3b --remote --output BACKUP_PRIVATE_PATH
python scripts/cloudflare/restore-check.py BACKUP_PRIVATE_PATH
```

Armazene exportações cifradas, com acesso restrito, checksum, data UTC e versão do schema.
Backups contêm dados pessoais e hashes/ciphertexts: não publique nem coloque em Git.
O verificador restaura SQL até 128 MiB em banco temporário, confere integridade/FKs e
recusa ATTACH/extensões. Exports maiores exigem ensaio próprio em ambiente isolado.
[Importação/exportação oficial](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Restauração real exige autorização separada e tráfego suspenso. Identifique banco e
bookmark; confira a janela e o impacto; restaure pelo procedimento oficial; valide schema,
Fks, contagens e fluxos de acesso; reconfigure chaves compatíveis e revogue sessões se
necessário; só então libere tráfego. Faça ensaio regular e registre tempo e perda observados.

## Limpeza, observação e configuração externa

A limpeza tem lotes e rodadas limitados. A cadência admite a execução exatamente após
60 segundos. Um lease de 60 segundos é renovado em cada batch; as escritas e o relatório
final conferem o token do lease na mesma transação. Um ciclo suspenso que perca o lease
não pode limpar dados nem sobrescrever o relatório do sucessor. Padrão versionado: 2.000 registros por lote,
até duas rodadas por minuto por tabela: teto teórico de 5,76 milhões/dia, dependente da
execução real, quota D1 e duração. Compare com volume previsto e observado, não apenas
com esse teto. Leituras: 90 dias; auditoria/eventos: 180 dias; contadores: 7 dias;
códigos de ativação encerrados e recuperações consumidas: 7 dias; descobertas abandonadas:
1 dia; cache velho: até 30 minutos após validade; sessões/desafios/tokens expirados são
removidos em ciclos limitados. A exclusão remove caches relacionados imediatamente.
IDs mínimos de auditoria são preservados pelo prazo definido, sem nome/e-mail/IP.

Cada invocação reserva um orçamento conservador de 50 statements SQL, incluindo lease,
consulta de backlog e relatório final. O backlog de todas as tabelas é consultado em um
único SELECT. O padrão de duas rodadas é preservado; solicitar três rodadas pode executar
menos rodadas para encerrar o ciclo com relatório e indicar os dados que ainda restam.
Esta contagem local não comprova como o plano publicado contabiliza batches nem sua
quota efetiva; confira os [limites oficiais do D1](https://developers.cloudflare.com/d1/platform/limits/).

Monitorar externamente: readiness 503; ausência de execução bem-sucedida do cron por
mais de três minutos; `maintenance.backlog=true` em ciclos consecutivos; falhas de mail;
erros da integração; quota de leituras/escritas/armazenamento D1. A persistência do marcador
de manutenção e logs não cria alertas por si só. É necessário configurar monitor e destinatário.

Observabilidade D1 ignora requisições anônimas/negadas/inválidas e amostra sucessos
autenticados (padrão 1/100). `request_count` conta amostras, não total de tráfego.
Falhas de segurança são amostradas; transições bem-sucedidas e auditoria de mutações
continuam persistidas. Não há flush periódico obrigatório em memória do isolate.

`METRICS` é opcional e não está provisionado no TOML. Se Analytics Engine for escolhido,
adicione o binding e configure acesso/retencão; até lá, o Worker tolera sua ausência.
Registros da plataforma e backups têm política externa, não coberta pelos DELETEs do D1.
Defina retenção de logs e proteção contra logging de URLs de recuperação/confirmação.
As aplicações removem tokens da barra, mas isso não apaga logs de acesso da plataforma.

Configure limites externos na rota real da API, incluindo aliases, sem considerar CORS
como proteção contra clientes automatizados. Nenhuma regra WAF, backup agendado,
DNS de remetente ou alarme foi declarado ativo apenas por existir este documento.
