# Inspeção da MonitorIE — 17/09/2026

> Atualização posterior: o usuário forneceu orientações do suporte e o Swagger
> oficial. O contrato comum foi consultado e uma camada de protocolo local foi
> preparada. Veja `MONITORIE.md` para o estado atual. O texto abaixo registra
> a inspeção inicial do painel, anterior a essa documentação. O usuário também
> esclareceu que os medidores estavam desligados durante aquela inspeção.

## Resultado

Login manual concluído pelo usuário em https://monitorie.com.br/login.
O perfil autenticado estava acessível. A inspeção foi somente pela interface,
sem extrair cookies, tokens, senha ou dados internos da sessão.

Não foi possível confirmar acesso aos dispositivos SM-WU e SM-WA. O painel
acessível exibiu `Nenhum dado para exibição em widget`, valores `N/A` e, na
tabela de entidades de Configurações, `Nenhuma entidade encontrada`.
Isso não prova que a conta inteira não tenha dispositivos: o vínculo ao painel,
as permissões e o provisionamento precisam ser esclarecidos pelo fornecedor.

## Evidências visíveis

- Tempo Real: sem leituras; tabela de alarmes vazia.
- Técnica: rótulos `Vazão [L/H]`, `Consumido [L]`,
  `Consumo Acumulado [L]` e `Consumo Consolidado em R$`, todos sem dados.
- Técnica: tabela com indicação de exportação CSV/XLS/XLSX, mas `Sem dados!`.
- Relatórios: consumo em litros, sem registros reais confirmados.
- Filtros de histórico na interface: última hora, últimas 24 horas, última
  semana, últimos 30 dias, mês atual, mês anterior e ano atual.
- Agrupamento da interface: 10 minutos, 1 hora e 1 dia; os dois primeiros
  estavam desabilitados para a janela selecionada de 30 dias.
- Configurações: nenhuma entidade encontrada; sem identificação dos medidores.
- Conta > Security: opção `Copy JWT token`, com validade indicada na tela.
  Essa opção não foi acionada, respeitando a proibição de reutilizar tokens
  da sessão do navegador como credenciais da API.

Os rótulos acima são do painel. Não confirmam nomes de campos JSON, unidades
do payload da API, modelo do equipamento, valores medidos ou paginação da API.
O identificador presente na URL é de um dashboard; não deve ser usado como
`external_id` de um dispositivo.

## Contrato da integração ainda não confirmado

Nas telas inspecionadas não foi localizada documentação da API nem opção de
criar credencial permanente de integração. A pesquisa pública nos domínios
MonitorIE e IE Tecnologia também não forneceu o contrato da API.

Permanecem pendentes: endpoints oficiais de snapshot e histórico, método de
autenticação autorizado para servidor, escopos/renovação, IDs reais de cada
modelo, campos/unidades/timestamps, paginação, retenção e limites de consulta.

O código local mantém `MonitorieSMWUAdapter` e `MonitorieSMWAAdapter` como
implementações indisponíveis, respondendo `MONITORIE_NOT_CONFIGURED`.
O contrato interno não deve ser confundido com o contrato do fornecedor.

## Alterações e testes

Somente este relatório foi adicionado. Nenhum adaptador, vínculo no D1,
secret, configuração da MonitorIE ou dispositivo foi alterado. Não houve
deploy nem envio de mensagens de teste.

Verificações realizadas: navegação autenticada e leitura de Tempo Real,
Técnica, Relatórios, Configurações, Perfil e Security.
Testes reais de snapshot, histórico, cache, indisponibilidade e isolamento
entre clientes permanecem pendentes da documentação, dispositivos acessíveis
e credencial oficial. Não foram executados testes automatizados nesta etapa,
pois não houve alteração de código executável.

## Próxima ação necessária

Solicitar à IE Tecnologia confirmação do vínculo e acesso dos dois medidores
nesta conta/painel, além do contrato e da forma oficial de autenticação da API
incluída no plano contratado. Não presumir que os medidores estejam offline
ou alterar sua transmissão para tentar resolver a ausência de entidades.

Após esclarecer esses pontos, implementar e testar os adaptadores; confirmar
os vínculos antes de escrever IDs no D1; pedir confirmação imediatamente antes
de criar credencial permanente, se necessário. O usuário inserirá os segredos
diretamente no Cloudflare Worker. A publicação de produção depende de relatório
dos resultados e confirmação final do usuário.
