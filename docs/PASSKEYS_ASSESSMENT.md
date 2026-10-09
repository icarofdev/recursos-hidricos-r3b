# Avaliação futura: passkeys e MFA opcional

Avaliação em 30/09/2026. Nenhuma das opções abaixo está implementada nesta etapa. O TOTP atual continua obrigatório apenas para contas identificadas como admin pelo backend; usuários comuns continuam entrando com a senha, sem confirmação de e-mail.

## Opções e esforço

| Opção                          | Implementação neste projeto                                                                                                                        | Esforço relativo                                                                                                       | Cobrança por autenticação                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Passkeys próprias com WebAuthn | Novos endpoints de cadastro/autenticação/remoção, desafios de uso único, credenciais públicas no D1 e interface do navegador                       | Maior: requer validar biblioteca no Worker, origem/RP ID, verificação do usuário, recuperação e múltiplos dispositivos | Sem tarifa de um provedor de autenticação; usa Workers e D1 existentes |
| TOTP opcional para usuários    | Preferência explícita por conta, cadastro protegido, armazenamento criptografado, etapa condicional no login, recuperação e desligamento protegido | Menor que passkeys por reutilizar primitivas existentes, mas exige fluxo próprio e testes completos                    | Sem tarifa de um provedor de autenticação; usa Workers e D1 existentes |

As estimativas de esforço são uma avaliação da arquitetura atual, não um prazo contratado. Não é necessário contratar um domínio para experimentar passkeys na origem HTTPS estável `https://hidra-r3b.vercel.app`. Uma mudança posterior de domínio exige planejar a continuidade das credenciais vinculadas ao RP ID; URLs variáveis de Preview não devem virar a identidade de produção.

## Custos de infraestrutura

A biblioteca SimpleWebAuthn tem [licença MIT](https://github.com/MasterKale/SimpleWebAuthn/blob/master/LICENSE.md); não há licença por usuário. Ainda é necessário validar sua compatibilidade com o runtime Worker antes de escolher versões e dependências. A alternativa usa APIs WebAuthn do navegador e WebCrypto no backend, sem enviar segredos a um serviço de autenticação externo.

Segundo a [tabela oficial de Workers](https://developers.cloudflare.com/workers/platform/pricing/), o plano Paid começa em US$ 5/mês por conta. A [tabela do D1](https://developers.cloudflare.com/d1/platform/pricing/) inclui, no Free, 5 milhões de linhas lidas e 100 mil escritas por dia; no Paid, 25 bilhões lidas e 50 milhões escritas por mês, com excedentes de US$ 0,001 por milhão de leituras e US$ 1 por milhão de escritas. Índices também contam como escritas. O plano efetivo desta conta e o consumo mensal não foram verificados nesta avaliação; não é possível afirmar um custo incremental exato.

Para estimar custo, medir em Preview as requisições, tempo de CPU e `rows_read`/`rows_written` por cadastro e login, incluindo limites de tentativas, sessões, auditoria e observabilidade. As duas opções podem caber na franquia já contratada, mas isso depende do uso total da conta. Não usar o limite de autenticações como estimativa direta de linhas escritas.

## Proposta para passkeys

1. Manter o fluxo atual e acrescentar uma opção de cadastro na conta, protegida por autenticação recente. Para admins, manter a exigência de TOTP recente existente.
2. Criar uma migration aditiva para credenciais e desafios: identificador de credencial, chave pública, identificador interno da conta, contador, flags de backup e transportes. O backend não guarda a chave privada, biometria ou PIN.
3. Gerar desafios com aleatoriedade segura, expiração curta, vínculo à sessão/conta e consumo atômico no D1. Proteger o cadastro e a remoção com CSRF e aplicar limites por conta e IP.
4. Validar assinatura, desafio, origem exata e RP ID, exigindo verificação do usuário. Validar comportamento de contadores para passkeys sincronizadas, sem tratar todo contador zero como fraude. A autorização continua vindo do D1, nunca da presença de uma credencial.
5. Testar múltiplas credenciais, replay, credencial de outra conta/origem, sessões concorrentes, revogação, dispositivos sem suporte e recuperação. Uma passkey de admin não substitui automaticamente o TOTP obrigatório nesta etapa.

Referências técnicas: [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server), [passkeys](https://simplewebauthn.dev/docs/advanced/passkeys) e [WebAuthn W3C](https://www.w3.org/TR/webauthn-2/). O código deve verificar as propriedades da credencial e a resposta criptográfica; adicionar apenas um botão de biometria no frontend não implementa passkeys.

## Proposta para TOTP opcional

Usar uma preferência explícita de MFA do usuário comum, separada de `users.role`. Reutilizar geração segura, criptografia, hashing de recuperação e reserva atômica de tentativas, preservando os autenticadores admin já cadastrados. Acrescentar autenticação recente para ativar, trocar ou desligar o método e impedir desligamento apenas com senha quando MFA estiver ativo. Definir recuperação antes de lançar; a recuperação de senha não pode apagar silenciosamente o segundo fator.

O login de quem não aderiu continua funcionando como hoje. Só quem concluir o cadastro terá uma etapa adicional. A escolha futura recomendada é experimentar passkeys em Preview antes de decidir pela ampliação de TOTP, mantendo recuperação, compatibilidade do navegador e domínio estável como critérios de aceitação.
