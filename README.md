<div align="center">

# Claude Cloud Bridge

**A secure, zero-dependency Node.js bridge that lets a cloud-based Claude run commands and read or write files on your local machine.**

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16-339933?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![API key](https://img.shields.io/badge/API%20key-rotating%20/%2024h-orange)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

</div>

---

## About

Claude Cloud Bridge turns the cloud session into a remote operator for your own computer. You start a small Node.js agent on your machine, expose it through a tunnel, and hand Claude the address plus a one-time API key. From that point Claude can execute shell commands and perform file operations on your machine, as if it were working locally instead of in a cloud container.

Access is gated by a random 256-bit API key that is regenerated on every start and expires after 24 hours by default. No key, no access. Close the bridge and all access stops. The agent has zero external dependencies, so a plain `node server.js` is all it needs.

---

<details open>
<summary><b>English (click to collapse)</b></summary>

### Overview

| | |
|---|---|
| **What it is** | A local HTTP agent plus a cloud-side client that together let Claude operate your machine. |
| **Security** | Random 256-bit API key per start, 24h expiry, timing-safe checks. |
| **Dependencies** | None. Node.js built-in modules only. |
| **Transport** | Plain HTTP over a tunnel (Cloudflare, ngrok) or a direct IP. |

### How it works

```
Cloud (Claude)                             Your computer
+--------------------+    HTTPS tunnel     +----------------------+
|  client.js         | ------------------> |  server.js           |
|  or curl / fetch   |   Bearer API key    |  (bridge agent)      |
+--------------------+                     |  exec + file ops     |
                                           +----------------------+
```

1. `server.js` runs on your computer and listens for authenticated requests.
2. A tunnel gives that local port a public HTTPS address.
3. Claude (cloud side) calls the address with the API key and does the work.

### Features

* Run any shell command with working directory, timeout, and custom environment.
* Read and write files as UTF-8 or base64 (so binary files work too).
* List directories, stat paths, create folders, move, and delete.
* Transparent logging: every request is printed in your terminal so you can watch.
* Fully configurable through environment variables.

### Quick start

**1. Start the bridge on your computer**

```bash
node server.js
```

The terminal prints a 64-character API key and its 24-hour expiry. Copy the key.

**2. Expose your machine (tunnel)**

Most home or office machines sit behind NAT, so a tunnel is the easiest path:

```bash
cloudflared tunnel --url http://localhost:8787
# or
ngrok http 8787
```

You get a public address such as `https://xxxx.trycloudflare.com`.

**3. Hand Claude two things**

* The public address (`BRIDGE_URL`)
* The API key (`BRIDGE_KEY`)

Claude can now operate your machine until the key expires or you close the bridge.

### Using the bridge (cloud side)

```bash
export BRIDGE_URL="https://xxxx.trycloudflare.com"
export BRIDGE_KEY="your-64-char-key"

node client.js status
node client.js exec "ls -la ~"
node client.js exec --cwd /home/user/project "npm test"
node client.js read  /home/user/note.txt
node client.js write /home/user/hello.txt "Hello"
node client.js list  ~/Desktop
node client.js delete --recursive /tmp/scratch
```

Or with plain `curl`:

```bash
curl -s "$BRIDGE_URL/exec" \
  -H "Authorization: Bearer $BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command":"whoami && pwd"}'
```

### API reference

Every endpoint except `GET /health` requires the API key, sent as
`Authorization: Bearer <key>` or `x-api-key: <key>`.

| Method | Path | Body (JSON) | Description |
|--------|------|-------------|-------------|
| GET  | `/health` | none | Liveness check (no auth, no sensitive data) |
| GET  | `/status` | none | Server and key status, platform info |
| POST | `/exec` | `{command, cwd?, shell?, timeout?, env?}` | Run a command |
| POST | `/fs/read` | `{path, encoding?}` | Read a file (`encoding:"base64"` for binary) |
| POST | `/fs/write` | `{path, content, encoding?, append?, mkdirs?}` | Write a file |
| POST | `/fs/list` | `{path}` | List a directory |
| POST | `/fs/stat` | `{path}` | Inspect a file or directory |
| POST | `/fs/mkdir` | `{path}` | Create a directory (recursive) |
| POST | `/fs/delete` | `{path, recursive?}` | Delete a file or directory |
| POST | `/fs/move` | `{from, to, mkdirs?}` | Move or rename |

The `/exec` response is
`{ok, exitCode, signal, timedOut, truncated, durationMs, stdout, stderr}`.
Paths starting with `~` are expanded to your home directory.

### Configuration

Set these environment variables when starting the server.

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_HOST` | `0.0.0.0` | Interface to bind |
| `BRIDGE_PORT` | `8787` | Port |
| `BRIDGE_KEY_TTL_HOURS` | `24` | API key lifetime in hours |
| `BRIDGE_API_KEY` | empty | Use a fixed key (not recommended; random if empty) |
| `BRIDGE_MAX_BODY_MB` | `100` | Maximum request body (file writes) |
| `BRIDGE_EXEC_TIMEOUT_MS` | `120000` | Command timeout |
| `BRIDGE_EXEC_MAX_OUTPUT_MB` | `50` | Maximum captured command output |

Example, an 8-hour key on a different port:

```bash
BRIDGE_KEY_TTL_HOURS=8 BRIDGE_PORT=9000 node server.js
```

### Security

Read this before you run the bridge. While it is up, it grants unrestricted
command execution on your computer. That is powerful and risky, so:

* **Keep the key private.** Do not paste it into public places. It rotates on every start, so if you suspect it leaked, restart the bridge and the old key dies instantly.
* **Close it when done.** Run the bridge only while working with Claude, then stop it with `Ctrl+C`. While it is closed, no access is possible.
* **The key expires in 24 hours.** After that, all requests are rejected until you restart. Use `BRIDGE_KEY_TTL_HOURS` for a shorter window.
* **Watch the commands.** Every command is logged in your terminal. If you see something unexpected, press `Ctrl+C`.
* **Guard the tunnel address too.** Address plus key together equal access.
* There is intentionally no path or command sandbox, by request. If you want to confine the agent to a single directory, that can be added.

### Troubleshooting

| Symptom | Likely cause and fix |
|---------|----------------------|
| `401 API key required` | `BRIDGE_KEY` not set, or header missing |
| `401 API key expired` | Restart the bridge to mint a new key |
| Connection times out | Is the tunnel running? Try `node client.js health` |
| Not reachable from cloud | A firewall may block the port; use a tunnel |

</details>

---

<details>
<summary><b>Türkçe (genişletmek için tıklayın)</b></summary>

### Genel bakış

| | |
|---|---|
| **Nedir** | Yerelde çalışan bir HTTP ajanı ve cloud tarafı bir istemci; birlikte Claude'un makineni kullanmasını sağlar. |
| **Güvenlik** | Her başlatmada rastgele 256-bit API key, 24 saat geçerlilik, timing-safe kontrol. |
| **Bağımlılık** | Yok. Sadece Node.js yerleşik modülleri. |
| **İletişim** | Tünel (Cloudflare, ngrok) veya doğrudan IP üzerinden düz HTTP. |

### Nasıl çalışır

```
Cloud (Claude)                             Senin bilgisayarin
+--------------------+    HTTPS tunel      +----------------------+
|  client.js         | ------------------> |  server.js           |
|  veya curl / fetch |   Bearer API key    |  (kopru ajani)       |
+--------------------+                     |  komut + dosya       |
                                           +----------------------+
```

1. `server.js` senin bilgisayarında çalışır ve kimlik doğrulanmış istekleri bekler.
2. Bir tünel bu yerel porta genel bir HTTPS adresi verir.
3. Claude (cloud tarafı) bu adrese API key ile istek atar ve işi yapar.

### Özellikler

* Herhangi bir kabuk komutunu çalışma dizini, zaman aşımı ve özel ortam ile çalıştırma.
* Dosyaları UTF-8 veya base64 olarak okuma/yazma (ikili dosyalar da çalışır).
* Dizin listeleme, yol bilgisi (stat), klasör oluşturma, taşıma ve silme.
* Şeffaf loglama: her istek terminalinde görünür, izleyebilirsin.
* Ortam değişkenleriyle tam yapılandırma.

### Hızlı başlangıç

**1. Köprüyü bilgisayarında başlat**

```bash
node server.js
```

Terminal 64 karakterlik API key'i ve 24 saatlik geçerliliğini yazar. Key'i kopyala.

**2. Makineni dışarı aç (tünel)**

Çoğu ev veya iş makinesi NAT arkasında olduğundan en kolay yol tünel:

```bash
cloudflared tunnel --url http://localhost:8787
# veya
ngrok http 8787
```

`https://xxxx.trycloudflare.com` gibi bir genel adres verir.

**3. Claude'a iki şeyi ver**

* Genel adres (`BRIDGE_URL`)
* API key (`BRIDGE_KEY`)

Claude artık key süresi dolana veya sen kapatana kadar makineni kullanabilir.

### Köprüyü kullanma (cloud tarafı)

```bash
export BRIDGE_URL="https://xxxx.trycloudflare.com"
export BRIDGE_KEY="64-karakterlik-key"

node client.js status
node client.js exec "ls -la ~"
node client.js exec --cwd /home/kullanici/proje "npm test"
node client.js read  /home/kullanici/not.txt
node client.js write /home/kullanici/selam.txt "Merhaba"
node client.js list  ~/Desktop
node client.js delete --recursive /tmp/gecici
```

Veya düz `curl` ile:

```bash
curl -s "$BRIDGE_URL/exec" \
  -H "Authorization: Bearer $BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command":"whoami && pwd"}'
```

### API referansı

`GET /health` dışındaki tüm uç noktalar API key ister;
`Authorization: Bearer <key>` veya `x-api-key: <key>` başlığı ile.

| Yöntem | Yol | Gövde (JSON) | Açıklama |
|--------|-----|--------------|----------|
| GET  | `/health` | yok | Canlılık kontrolü (auth yok, hassas bilgi yok) |
| GET  | `/status` | yok | Sunucu ve key durumu, platform bilgisi |
| POST | `/exec` | `{command, cwd?, shell?, timeout?, env?}` | Komut çalıştır |
| POST | `/fs/read` | `{path, encoding?}` | Dosya oku (`encoding:"base64"` ikili için) |
| POST | `/fs/write` | `{path, content, encoding?, append?, mkdirs?}` | Dosya yaz |
| POST | `/fs/list` | `{path}` | Dizin listele |
| POST | `/fs/stat` | `{path}` | Dosya veya dizin bilgisi |
| POST | `/fs/mkdir` | `{path}` | Dizin oluştur (recursive) |
| POST | `/fs/delete` | `{path, recursive?}` | Dosya veya dizin sil |
| POST | `/fs/move` | `{from, to, mkdirs?}` | Taşı veya yeniden adlandır |

`/exec` yanıtı:
`{ok, exitCode, signal, timedOut, truncated, durationMs, stdout, stderr}`.
`~` ile başlayan yollar ev dizinine genişletilir.

### Yapılandırma

Sunucuyu başlatırken bu ortam değişkenlerini verebilirsin.

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `BRIDGE_HOST` | `0.0.0.0` | Dinlenecek arayüz |
| `BRIDGE_PORT` | `8787` | Port |
| `BRIDGE_KEY_TTL_HOURS` | `24` | API key geçerlilik süresi (saat) |
| `BRIDGE_API_KEY` | boş | Sabit key kullan (önerilmez; boşsa rastgele) |
| `BRIDGE_MAX_BODY_MB` | `100` | Maksimum istek gövdesi (dosya yazma) |
| `BRIDGE_EXEC_TIMEOUT_MS` | `120000` | Komut zaman aşımı |
| `BRIDGE_EXEC_MAX_OUTPUT_MB` | `50` | Maksimum komut çıktısı |

Örnek, farklı portta 8 saatlik key:

```bash
BRIDGE_KEY_TTL_HOURS=8 BRIDGE_PORT=9000 node server.js
```

### Güvenlik

Köprüyü çalıştırmadan önce oku. Açık olduğu sürece bilgisayarında
kısıtlamasız komut çalıştırma yetkisi verir. Bu güçlü ama riskli, bu yüzden:

* **Key'i gizli tut.** Herkese açık yerlere yapıştırma. Her başlatmada yenilenir; sızdığından şüphelenirsen köprüyü yeniden başlat, eski key anında geçersiz olur.
* **İşin bitince kapat.** Köprüyü sadece Claude ile çalışırken açık tut, sonra `Ctrl+C` ile durdur. Kapalıyken hiçbir erişim mümkün değil.
* **Key 24 saatte dolar.** Sonrasında tüm istekler reddedilir; yeniden başlatman gerekir. Daha kısa süre için `BRIDGE_KEY_TTL_HOURS` kullan.
* **Komutları izle.** Her komut terminalde loglanır. Beklenmedik bir şey görürsen `Ctrl+C`.
* **Tünel adresini de koru.** Adres artı key birlikte erişim demektir.
* İsteğin gereği bilinçli olarak yol veya komut sandbox'ı yoktur. Ajanı tek bir dizine hapsetmek istersen eklenebilir.

### Sorun giderme

| Belirti | Olası neden ve çözüm |
|---------|----------------------|
| `401 API key gerekli` | `BRIDGE_KEY` ayarlı değil veya başlık eksik |
| `401 API key suresi doldu` | Yeni key için köprüyü yeniden başlat |
| Bağlantı zaman aşımı | Tünel çalışıyor mu? `node client.js health` dene |
| Cloud'dan erişilemiyor | Güvenlik duvarı portu kapatıyor olabilir; tünel kullan |

</details>

---

## License

MIT
