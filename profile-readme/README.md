<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/header-dark.svg">
  <img src="assets/header-light.svg" alt="gi-os. Giovanni Lupo. Shops, phones, and one browser desktop." width="100%">
</picture>

```
$ whoami
giovanni lupo · new york · gio@gi-os.com
$ uptime
shipping since 2015
```

### About

I build small software. Shops that sell things, apps for a phone with no app
store, and a desktop that only ever existed in a browser tab.

Ten years of it. I usually own the whole thing: the schema, the API, the
interface, and the container it ships in.

### Shops

[Shuttle](https://github.com/LR-Paris/Shuttle) is a storefront platform. [Launchpad](https://github.com/LR-Paris/Launchpad)
is the dashboard that creates a shop, stocks it, and puts it online. One Docker
container per shop, nginx routing by path, orders and inventory as CSV. Session
auth with bcrypt and rate limiting, a file manager for the shop directory, and a
self-update that pulls a new version from GitHub while the platform runs.

Express and SQLite underneath, React and Vite on top, one DigitalOcean droplet
holding all of it. The client shops on lrparisstore.com run on it. Version 4.

### Phones

The Light Phone III has a black and white screen and a home screen that is a
list of words. I wrote the apps it does not ship with, and the store they live
in: twenty apps in Kotlin, one shared library, one marketplace with a submission
portal.

| | |
| --- | --- |
| [BrightMarket](https://github.com/gi-os/BrightMarket) | The app store, plus an [index](https://github.com/gi-os/brightmarket-index) to submit to it |
| [Roll](https://github.com/gi-os/Roll) | Camera with filters |
| [BrightNotebook](https://github.com/gi-os/BrightNotebook) | Notes, folders, calendar |
| [BrightMusic](https://github.com/gi-os/BrightMusic) | Spotify client |
| [BrightRecorder](https://github.com/gi-os/BrightRecorder) | Voice recorder |
| [BrightLibrary](https://github.com/gi-os/BrightLibrary) | E-reader with manga and Calibre support |

Fifteen more sit behind those:
[Control](https://github.com/gi-os/BrightControl) ·
[Import](https://github.com/gi-os/BrightImport) ·
[Transit](https://github.com/gi-os/BrightTransit) ·
[Way](https://github.com/gi-os/BrightWay) ·
[Sports](https://github.com/gi-os/BrightSports) ·
[Authenticator](https://github.com/gi-os/BrightAuthenticator) ·
[thumb](https://github.com/gi-os/brightthumb) ·
[Common](https://github.com/gi-os/BrightCommon) ·
[Solitaire](https://github.com/gi-os/BrightSolitaire) ·
[Sudoku](https://github.com/gi-os/BrightSudoku) ·
[Nonogram](https://github.com/gi-os/BrightNonogram) ·
[News](https://github.com/gi-os/BrightNews) ·
[Noise](https://github.com/gi-os/BrightNoise) ·
[Passes](https://github.com/gi-os/BrightPasses) ·
[Sync](https://github.com/gi-os/BrightSync)

My girlfriend carries a Kyocera flip phone, so that got a
[launcher](https://github.com/gi-os/PickleLauncher) and a
[solitaire](https://github.com/gi-os/PickleSolitaire) too.

### Systems

```
Gi-OS            a desktop in a browser tab. started 2015, now on version 7
PassportOS       C, for the Passport device
June4 / June7    a virtual secretary, written before the assistants arrived
```

### Odds and ends

```
zip              PWA clone of the LinkedIn Zip puzzle
TeslaHUD         a heads-up display for a car that already has one
basilnethome     the front door to my home server
```

### Stack

```
kotlin, android           20 apps, one shared library, one app store
node, express, sqlite     shuttle and launchpad, version 4
react, vite, tailwind     the dashboard the shops are run from
docker, nginx, ubuntu     one container per shop, one droplet, no kubernetes
bash                      more of it than I plan on
```

### Elsewhere

[gzl.dev](https://gzl.dev) holds the blog, the bookshelf, the film log, and the
photographs. Everything else is on this page.

```
battery ▓▓▓▓▓▓▓░░ 78%     signal ▁▃▅     unread 0
```

No badges. They do not fit on the screen.
