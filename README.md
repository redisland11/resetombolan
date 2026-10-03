# Resetombolan

Två filer behövs på servern: `index.html` och `server.js`. Kräver Node.js 18 eller senare, inga paket att installera.

## Snabbinstallation på en Linux-server

Kör som root (till exempel i Linodes LISH-konsol):

```bash
curl -fsSL https://raw.githubusercontent.com/redisland11/resetombolan/main/install.sh | bash
```

Skriptet installerar Node.js 22 om det saknas, lägger filerna i `/opt/resetombolan`, startar tjänsten `resetombolan` och skriver ut adressen och adminnyckeln. Kör samma rad igen för att uppdatera.

## Starta för hand

```bash
node server.js
```

- Deltagare: `http://din-server:8080/`
- Admin: `http://din-server:8080/admin`

Första gången skapas en adminnyckel i `admin-key.txt` (den skrivs också ut i terminalen). Lotterna sparas i `tombola-data.json`.

Inställningar via miljövariabler:

| Variabel | Standard | Vad |
|---|---|---|
| `PORT` | 8080 | Port |
| `HOST` | 0.0.0.0 | Adress att lyssna på |
| `ADMIN_KEY` | (filen admin-key.txt) | Egen adminnyckel |
| `DATA_FILE` | tombola-data.json | Var lotterna sparas |

## Så går en dragning till

1. Öppna `/admin`, logga in med nyckeln.
2. Skriv in namnen och välj 1–10 kulor per person (högst 60 totalt).
3. Tryck **Kopiera länk** vid varje namn och skicka länken privat. Koden ligger i länken, så de behöver inte skriva något.
4. Listan visar "inne" när någon har öppnat sin länk.
5. Tryck **Dra en vinnare**. Servern väljer en kula slumpmässigt bland alla kulor, så fler kulor ger proportionellt större chans.

Bara vinnaren och admin får veta vem som vann. Den publika delen av servern säger aldrig namn, antal kulor per person eller vinnare.

Om du ändrar kulor eller lägger till någon behåller de andra sina koder. **Ge alla nya koder** gör alla gamla länkar ogiltiga.

## Hålla den igång (systemd)

`/etc/systemd/system/tombola.service`:

```ini
[Unit]
Description=Resetombolan
After=network.target

[Service]
WorkingDirectory=/opt/tombola
ExecStart=/usr/bin/node /opt/tombola/server.js
Environment=PORT=8080
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tombola
```

## HTTPS

Kör den bakom Cloudflare (orange moln på DNS-posten) eller en omvänd proxy som Caddy eller nginx. Live-uppdateringen går via `/api/events` (Server-Sent Events). I nginx behöver den platsen buffring avstängd:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

Sidan fungerar också under en undermapp, till exempel `https://example.se/tombola/` och `https://example.se/tombola/admin`.
