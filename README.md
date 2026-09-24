# Postar no Instagram + TikTok (versão web)

Página estática para publicar um vídeo do celular no **Instagram** (Reels ou Stories) e no **TikTok** ao mesmo tempo, usando a API da [Zernio](https://zernio.com).

**Link:** https://hgovrs.github.io/postar/

## Como usar no celular

1. Abra o link e configure a chave da API, de um destes jeitos:
   - escaneie o QR code gerado no computador, que já configura tudo;
   - ou cole a chave em **Configurar este aparelho**.
2. **Instale na tela inicial**, se quiser:
   - no iPhone, abra o link no Safari e toque em Compartilhar → Adicionar à Tela de Início;
   - no Android, no menu do Chrome, toque em Instalar app ou Adicionar à tela inicial.
3. Escolha o vídeo, escreva a legenda e ajuste as opções:
   - **Instagram:** Reels (com opção de aparecer também no feed) ou Stories;
   - **Capa** (Reels e TikTok): padrão, um quadro do vídeo escolhido no controle deslizante, ou uma imagem da galeria;
   - **TikTok:** quem pode ver, interações, rascunho, divulgação de conteúdo comercial e rótulo de IA.
4. Marque a confirmação e toque em **Publicar**.

Mantenha a tela aberta só enquanto o vídeo é enviado. Depois disso, a publicação é agendada para daqui a cerca de 30 segundos e continua na Zernio mesmo que você bloqueie o celular. Ao voltar para a página, ela mostra o resultado e os links.

## O que a página faz com o vídeo

- Lê duração, resolução e codecs direto do arquivo (MP4/MOV) e avisa quando algo passa dos limites de cada rede.
- Quando os metadados do arquivo (moov) estão no fim, como em muitos vídeos de celular, move-os para o início sem recodificar, como o Instagram exige.
- Converte a imagem de capa para JPEG, o que também resolve fotos HEIC do iPhone.
- Não converte formatos, porque isso exigiria recodificar no celular. Vídeos gravados pelo celular (H.264/HEVC com AAC) já são aceitos pelas duas redes.

## Segurança

- A chave fica só no `localStorage` do aparelho e é enviada apenas para a Zernio (`zernio.com`).
- A página não carrega nenhum script de terceiros, e a CSP só permite scripts do próprio site.
- Para o celular, use uma chave **restrita e exclusiva**, que pode ser revogada no painel da Zernio sem afetar o computador.
- **Esquecer a chave** (menu ⚙) apaga a chave do aparelho.

## Limites

| | Instagram Reels | Instagram Stories | TikTok |
|---|---|---|---|
| Duração | 3 s a 15 min (acima de 90 s pode ser recusado) | 3 a 60 s | 3 s a 10 min (vale o limite da conta) |
| Tamanho | até 300 MB | até 100 MB | até 4 GB |
| Formatos | MP4, MOV | MP4, MOV | MP4, MOV, WebM |

- **TikTok:** vídeo publicado direto em contas do TikTok for Business só pode ser Público. Para outra privacidade, use o rascunho.
- **Instagram:** Stories não mostram legenda nem capa.

## Desenvolvimento

Sem build e sem dependências: são só HTML, CSS e módulos JavaScript.

```powershell
# testes (Node 22+; FFMPEG_PATH habilita os testes com vídeo real)
node --test "tests/*.test.js"
```

| Arquivo | Função |
|---|---|
| `index.html`, `style.css` | Interface |
| `app.js` | Tela, envio, publicação e acompanhamento |
| `rules.js` | Regras das redes, validação e montagem do post |
| `api.js` | Cliente da API da Zernio (sem `x-request-id`, que o CORS da Zernio não permite) |
| `mp4.js` | Leitura de MP4/MOV e reorganização do moov (faststart) |

O GitHub Pages publica a branch `main` direto.
