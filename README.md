# XeroHost for VS Code

Edit the files of your XeroHost game servers, watch the live console and control power from inside VS Code. It works with any server of a XeroHost / Orbit panel (standard Pterodactyl client API and Wings).

## Features

- **Server files as a workspace folder.** A server is mounted as `xerohost://...` and behaves like a normal folder: browse, open, edit, create, rename, move, copy and delete. Large files go through the panel's signed upload/download links.
- **Console in a terminal.** Live console output with the recent log backlog, command input with history (up/down arrows), automatic token refresh and reconnection.
- **Status bar.** Shows the server state (running, offline...) with CPU, memory and disk in the tooltip. Click it to switch servers or to **start / restart / stop / kill** the server (stop and kill ask for confirmation).
- **Archives.** Right-click files in the explorer to compress them, or to extract an archive in place.
- **Deep link from the panel.** The panel can open a server straight in VS Code (see below).
- **Several panels.** Sign in to more than one panel; each one keeps its own key.

## Commands

All commands live under `XeroHost:` in the Command Palette: Sign In, Sign Out, Open Server Files, Open Server Console, Server Power Action.

## Deep link

```
vscode://xerohost.xerohost/open?origin=<panel origin>&server=<server id>&console=1&file=<path>
```

| Parameter | Meaning |
|---|---|
| `origin` | Panel origin, for example `https://panel.example.com`. Only `https://` is accepted (and `http://` for `localhost` / `127.0.0.1`). |
| `server` | Server identifier (the short 8 character id) or full UUID. |
| `console` | Optional. `1` also opens the console terminal. |
| `file` | Optional. Path relative to the server root to open after mounting. |

If you are not signed in to that panel yet, VS Code first asks for confirmation and then starts the sign-in.

## Signing in

1. Run **XeroHost: Sign In** and enter your panel URL (or open a deep link).
2. Your browser opens the panel's *Authorize VS Code* page. Sign in to the panel if needed and press **Authorize**.
3. The panel redirects to a loopback address on your own machine (`http://127.0.0.1:<port>/callback`) and the extension stores the new API key. A random one-time `state` value protects the callback.

In Remote / Codespaces sessions the callback goes through VS Code's own port forwarding. If the browser flow is not possible, paste an API key manually in the input box that appears while waiting (create one in the panel under *Account* -> *API Keys*).

## Privacy

- The API key is stored only in VS Code's **SecretStorage** (your operating system's keychain), one key per panel. It is never written to settings, logs or workspace files.
- The extension talks only to the panel you signed in to and to the game server node that panel hands out (signed download/upload links and the console websocket). No telemetry.
- To revoke access at any time, delete the key in the panel under **Cuenta -> Claves de API** (Account -> API Keys), or run **XeroHost: Sign Out** to forget it locally.

## Settings

| Setting | Default | Description |
|---|---|---|
| `xerohost.console.prompt` | `container@xerohost~` | Prompt shown in front of console messages. |
| `xerohost.files.downloadThresholdMiB` | `4` | Files larger than this are fetched through a signed download link. |

## Not included (v1)

Content search across a server, file history, real-time collaboration, command snippets and backup progress need services that standard Wings does not offer, so they are left out.

---

# XeroHost para VS Code (Español)

Edita los archivos de tus servidores de XeroHost, mira la consola en vivo y controla la energía sin salir de VS Code. Funciona con cualquier servidor de un panel XeroHost / Orbit (API de cliente de Pterodactyl y Wings estándar).

## Funciones

- **Archivos del servidor como carpeta de trabajo.** El servidor se monta como `xerohost://...` y se comporta como una carpeta normal: explorar, abrir, editar, crear, renombrar, mover, copiar y borrar. Los archivos grandes usan los enlaces firmados de subida y descarga del panel.
- **Consola en una terminal.** Salida en vivo con el historial reciente, comandos con historial (flechas arriba/abajo), renovación automática del token y reconexión.
- **Barra de estado.** Muestra el estado del servidor (encendido, apagado...) y CPU, memoria y disco en el tooltip. Al hacer clic puedes cambiar de servidor o **iniciar / reiniciar / detener / matar** el servidor (detener y matar piden confirmación).
- **Archivos comprimidos.** Clic derecho en el explorador para comprimir o extraer en el mismo sitio.
- **Enlace directo desde el panel**, con el formato descrito arriba.
- **Varios paneles**, cada uno con su propia clave.

## Iniciar sesión

1. Ejecuta **XeroHost: Sign In** e indica la URL de tu panel (o abre un enlace directo).
2. El navegador abre la página *Autorizar VS Code* del panel. Inicia sesión si hace falta y pulsa **Autorizar**.
3. El panel redirige a una dirección local (`http://127.0.0.1:<puerto>/callback`) y la extensión guarda la nueva clave de API.

Si el navegador no es una opción, pega una clave de API en el cuadro que aparece mientras espera (se crea en el panel, en *Cuenta -> Claves de API*).

## Privacidad

- La clave de API se guarda solo en el **SecretStorage** de VS Code (el almacén de credenciales de tu sistema), una por panel. Nunca se escribe en ajustes, logs ni archivos del proyecto.
- La extensión solo habla con el panel en el que iniciaste sesión y con el nodo del servidor que ese panel indica. Sin telemetría.
- Para revocar el acceso, borra la clave en el panel en **Cuenta -> Claves de API**, o ejecuta **XeroHost: Sign Out** para olvidarla en este equipo.

## Créditos

Basada en la [extensión de VS Code de Calagopus](https://github.com/calagopus/vscode-extension), licencia MIT, © Calagopus / 0x7d8. Se conserva su aviso de licencia en `LICENSE`. Adaptada por XeroHost para la API de cliente de Pterodactyl.

## Credits

Based on the [Calagopus VS Code extension](https://github.com/calagopus/vscode-extension), MIT licensed, © Calagopus / 0x7d8. Their license notice is kept in `LICENSE`. Adapted by XeroHost for the Pterodactyl client API.

## License

MIT. See `LICENSE`.
