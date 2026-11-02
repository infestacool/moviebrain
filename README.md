# 🎬 Triviarr

A small web app for your Unraid server. It shows what movie is playing on **Plex** or **Jellyfin** and displays trivia about it from **IMDb** and **Wikipedia**. It works on phones, tablets and computers.

- **Play/pause** the movie from the button beside the progress bar. This works with most Jellyfin apps and with Plex apps that support remote control (Plex Web doesn't).
- **Spotlight**: one fact at a time. Tap the card or use ← → to skip, and turn *Auto-advance* on to move to a new fact every 20 seconds.
- **Trivia**: the full list of IMDb trivia. Spoilers stay blurred until you tap them, unless you turn on the *Spoilers* toggle.
- **Goofs**: IMDb's list of filming mistakes, continuity errors and factual slips, with spoilers blurred the same way. You can turn goofs off in Settings.
- **Wikipedia**: production, release, reception and legacy sections from the film's article.
- If several movies are playing, buttons at the top let you switch between them. When nothing is playing, you can look up any movie by name.

## Install on Unraid

The image is built automatically by GitHub Actions on every push to `main` and published to `ghcr.io/infestacool/triviarr`. Unraid pulls it from there, so there's nothing to build on the server.

1. In the Unraid terminal, download the template so it appears in the Docker tab:
   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-triviarr.xml https://raw.githubusercontent.com/infestacool/triviarr/main/unraid/triviarr.xml
   ```
2. Go to **Docker → Add Container**, choose **triviarr** from the *Template* list, and click **Apply**. Unraid pulls the image.
3. Open `http://<unraid-ip>:8085`, click **⚙ Settings**, and enter your server details.

**Updating:** push changes to GitHub and wait for the *Build image* action to finish (a few minutes). Then in Unraid's Docker tab, click **Check for Updates** and **Apply Update** for triviarr. Your settings are kept in `/mnt/user/appdata/triviarr/settings.json`.

If you use the Docker Compose Manager plugin, you can use `docker-compose.yml` instead of steps 1–2.

## Settings

Everything is set up on the **Settings** page. You need **at least one** of Plex or Jellyfin, and you can use both.

| Server | URL example | Key |
|---|---|---|
| Plex | `http://0.0.0.0:32400` | **Plex token**: in Plex Web, open any item, then ⋯ → *Get Info* → *View XML*. Copy the `X-Plex-Token=` value from the address bar. |
| Jellyfin | `http://0.0.0.0:8096` | **API key**: *Dashboard → API Keys → +* |

Use **Test connection** to check each one before saving. *Only show movies played by* limits the page to certain users, for example so you don't see what the kids are watching in another room.

## Sign-in (optional)

Sign-in is **off by default**, so anyone on your network can open the page. To require it, choose an option under **Settings → Sign-in**:

- **Sign in with Plex**: anyone who has access to your Plex server can sign in. The server owner can open Settings. You can also add extra users with *Allowed users* and choose who can change settings with *Admins*.
- **Sign in with Pocket ID** (or any OpenID Connect provider, such as Authelia, Authentik or Keycloak):
  1. In Pocket ID, go to *Administration → OIDC Clients → Add OIDC Client*.
  2. Set the callback URL to the one shown on the Settings page (`http://<unraid-ip>:8085/auth/oidc/callback`).
  3. Paste the issuer URL (e.g. `https://id.example.com`), client ID and client secret into Triviarr.
  4. To control who gets in, either restrict the client to user groups in Pocket ID, or list emails, usernames or groups under *Allowed users*.

After you save, you'll be asked to sign in right away.

**Locked out?** Set the container variable `AUTH_DISABLE=true` (under *Show more settings* in the Unraid template), restart, fix the settings, then set it back to `false`.

If you use a reverse proxy and sign-in redirects to the wrong address, set **Advanced → Public URL** (e.g. `https://trivia.example.com`).

## Notes

- Movies are matched to Wikipedia through Wikidata using the IMDb or TMDb ID from your media server, so remakes and films with the same title are matched correctly.
- IMDb trivia comes from the data feed IMDb's own website uses. IMDb allows only limited personal, non-commercial use of its data, which a home server meets. You can turn IMDb trivia and goofs off separately in Settings.
- Trivia is cached in memory for 24 hours (`CACHE_HOURS` to change).

## Run locally for development

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```
```bash
CONFIG_DIR=./config .venv/bin/uvicorn app.main:app --reload --port 8085
```
