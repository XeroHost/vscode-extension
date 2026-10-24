# XeroHost for VS Code

Edit the files of your XeroHost game servers, watch the live console and control power from inside VS Code. It works with any server of a XeroHost / Orbit panel (standard Pterodactyl client API and Wings).

## Features

- **Server files as a workspace folder.** A server is mounted as `xerohost://...` and behaves like a normal folder: browse, open, edit, create, rename, move, copy and delete. Large files go through the panel's signed upload/download links.
- **Console in a terminal.** Live console output with the recent log backlog, command input with history (up/down arrows), automatic token refresh and reconnection.
- **Status bar.** Shows the server state (running, offline...) with CPU, memory and disk in the tooltip. Click it to switch servers or to **start / restart / stop / kill** the server (stop and kill ask for confirmation).
- **Sees changes made outside VS Code.** Edits made in the panel, by other people or by the server itself show up without reloading: the folders VS Code is watching are checked every few seconds, and open files that were not edited locally reload by themselves. **XeroHost: Refresh** (also a button in the Explorer title) checks everything right now.
- **Your language.** The interface, the commands and the sign-in page follow VS Code's display language: English, Spanish, Portuguese (Brazil), French, German, Italian, Turkish, Chinese (Simplified), Japanese and Korean.
- **Archives.** Right-click files in the explorer to compress them, or to extract an archive in place.
- **Deep link from the panel.** The panel can open a server straight in VS Code (see below).
- **Several panels.** Sign in to more than one panel; each one keeps its own key.

## Commands

All commands live under `XeroHost:` in the Command Palette: Sign In, Sign Out, Open Server Files, Open Server Console, Server Power Action and Refresh.

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
| `xerohost.files.pollIntervalSeconds` | `10` | Seconds between checks for changes made outside VS Code. `0` turns it off. Paused while the window is not focused. |

### Seeing outside changes

VS Code tells the extension which folders and files it is watching (the workspace root, expanded Explorer folders and open editors). Every `xerohost.files.pollIntervalSeconds` seconds the extension lists those folders and compares names, sizes and modification times with the previous listing, which fires the usual *created / changed / deleted* events: the Explorer updates, and an open file that has no unsaved edits reloads by itself. If you have unsaved edits when the file changes remotely, VS Code asks what to do when you save (overwrite or compare) as usual.

To stay far below the panel's API limit (about 240 requests per minute per user) the polling lists at most 20 folders per cycle and never more than 60 requests per minute, skips cycles while the window is in the background, and backs off (up to 8x longer) after any error or `429`. Lower values than 3 seconds are treated as 3. **XeroHost: Refresh** clears the caches and re-checks on demand, for one server (Explorer context menu on a folder) or all mounted ones.

## Languages

English (default), Spanish, Portuguese (Brazil), French, German, Italian, Turkish, Chinese (Simplified), Japanese and Korean. They follow VS Code's display language (`Configure Display Language`); the page the browser shows after signing in uses the browser's language instead.

## Not included (v1)

Content search across a server, file history, real-time collaboration, command snippets and backup progress need services that standard Wings does not offer, so they are left out.

---

# XeroHost para VS Code (Español)

Edita los archivos de tus servidores de XeroHost, mira la consola en vivo y controla la energía sin salir de VS Code. Funciona con cualquier servidor de un panel XeroHost / Orbit (API de cliente de Pterodactyl y Wings estándar).

## Funciones

- **Archivos del servidor como carpeta de trabajo.** El servidor se monta como `xerohost://...` y se comporta como una carpeta normal: explorar, abrir, editar, crear, renombrar, mover, copiar y borrar. Los archivos grandes usan los enlaces firmados de subida y descarga del panel.
- **Consola en una terminal.** Salida en vivo con el historial reciente, comandos con historial (flechas arriba/abajo), renovación automática del token y reconexión.
- **Barra de estado.** Muestra el estado del servidor (encendido, apagado...) y CPU, memoria y disco en el tooltip. Al hacer clic puedes cambiar de servidor o **iniciar / reiniciar / detener / matar** el servidor (detener y matar piden confirmación).
- **Ve los cambios hechos fuera de VS Code.** Lo que editas en el panel, otras personas o el propio servidor aparece sin recargar: las carpetas que VS Code vigila se revisan cada pocos segundos y los archivos abiertos sin cambios locales se recargan solos. **XeroHost: Actualizar** (también un botón en el título del Explorador) lo revisa todo al instante.
- **En tu idioma.** La interfaz, los comandos y la página de inicio de sesión siguen el idioma de VS Code: español, inglés, portugués (Brasil), francés, alemán, italiano, turco, chino simplificado, japonés y coreano.
- **Archivos comprimidos.** Clic derecho en el explorador para comprimir o extraer en el mismo sitio.
- **Enlace directo desde el panel**, con el formato descrito arriba.
- **Varios paneles**, cada uno con su propia clave.

## Ajustes

| Ajuste | Por defecto | Descripción |
|---|---|---|
| `xerohost.console.prompt` | `container@xerohost~` | Prompt que se muestra delante de los mensajes de la consola. |
| `xerohost.files.downloadThresholdMiB` | `4` | Los archivos más grandes se descargan con un enlace firmado. |
| `xerohost.files.pollIntervalSeconds` | `10` | Segundos entre revisiones de cambios hechos fuera de VS Code. `0` lo desactiva. Se pausa mientras la ventana no tiene el foco. |

### Cambios hechos fuera de VS Code

VS Code le dice a la extensión qué carpetas y archivos vigila (la raíz del espacio de trabajo, las carpetas desplegadas del Explorador y los editores abiertos). Cada `xerohost.files.pollIntervalSeconds` segundos la extensión lista esas carpetas y compara nombres, tamaños y fechas de modificación con el listado anterior; así dispara los eventos normales de *creado / modificado / borrado*: el Explorador se actualiza y un archivo abierto sin cambios sin guardar se recarga solo. Si tienes cambios sin guardar y el archivo cambia en remoto, VS Code te pregunta al guardar (sobrescribir o comparar), como siempre.

Para quedarse muy por debajo del límite de la API del panel (unas 240 peticiones por minuto y usuario), la revisión lista como máximo 20 carpetas por ciclo y nunca más de 60 peticiones por minuto, se salta los ciclos con la ventana en segundo plano y espera más (hasta 8 veces) tras cualquier error o `429`. Valores menores de 3 segundos se tratan como 3. **XeroHost: Actualizar** vacía las cachés y revisa al momento, para un servidor (menú contextual de una carpeta en el Explorador) o para todos los montados.

## Idiomas

Español, inglés (por defecto), portugués (Brasil), francés, alemán, italiano, turco, chino simplificado, japonés y coreano. Siguen el idioma de visualización de VS Code (`Configure Display Language`); la página que muestra el navegador tras iniciar sesión usa el idioma del navegador.

## Iniciar sesión

1. Ejecuta **XeroHost: Iniciar sesión** e indica la URL de tu panel (o abre un enlace directo).
2. El navegador abre la página *Autorizar VS Code* del panel. Inicia sesión si hace falta y pulsa **Autorizar**.
3. El panel redirige a una dirección local (`http://127.0.0.1:<puerto>/callback`) y la extensión guarda la nueva clave de API.

Si el navegador no es una opción, pega una clave de API en el cuadro que aparece mientras espera (se crea en el panel, en *Cuenta -> Claves de API*).

## Privacidad

- La clave de API se guarda solo en el **SecretStorage** de VS Code (el almacén de credenciales de tu sistema), una por panel. Nunca se escribe en ajustes, logs ni archivos del proyecto.
- La extensión solo habla con el panel en el que iniciaste sesión y con el nodo del servidor que ese panel indica. Sin telemetría.
- Para revocar el acceso, borra la clave en el panel en **Cuenta -> Claves de API**, o ejecuta **XeroHost: Cerrar sesión** para olvidarla en este equipo.

## Créditos

Basada en la [extensión de VS Code de Calagopus](https://github.com/calagopus/vscode-extension), licencia MIT, © Calagopus / 0x7d8. Se conserva su aviso de licencia en `LICENSE`. Adaptada por XeroHost para la API de cliente de Pterodactyl.

## Credits

Based on the [Calagopus VS Code extension](https://github.com/calagopus/vscode-extension), MIT licensed, © Calagopus / 0x7d8. Their license notice is kept in `LICENSE`. Adapted by XeroHost for the Pterodactyl client API.

## License

MIT. See `LICENSE`.
