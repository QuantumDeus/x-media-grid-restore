# X Media Grid Restore

[![Click Here for the Firefox Version](https://img.shields.io/badge/Firefox_Version-Click_Here-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://github.com/QuantumDeus/x-media-grid-restore-firefox)

[![Download for Chrome](https://img.shields.io/badge/Download_for_Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/QuantumDeus/x-media-grid-restore/releases/download/V1/x-media-grid-restore.zip)
![Total Downloads](https://img.shields.io/github/downloads/QuantumDeus/x-media-grid-restore/total?style=for-the-badge&logo=googlechrome&label=Downloads&color=4285F4)

## OR greasyfork Script
https://greasyfork.org/en/scripts/591463-x-media-grid-restore?locale_override=1


A minimal local Chrome extension that asks X to use its legacy profile media
layout. It runs only on `https://x.com/*`, has no background process, requests
no Chrome permissions, sends no network requests, and stores no data.

<img width="1536" height="986" alt="image" src="https://github.com/user-attachments/assets/b04c23ff-aad7-49e2-9cbe-c64b28162bf5" />


## How it works

Before X initializes its React application, the extension changes these two
feature flags in both the default and per-user configurations:

- `responsive_web_profile_redesign_enabled`
- `rweb_media_carousel_enabled`

Both values are changed from `true` to `false`. This works only while X still
ships the legacy media-grid component.

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `x-media-grid-restore` folder.
5. Reload an X profile's media page.

## Remove

Open `chrome://extensions` and remove **X Media Grid Restore**. Reload X to
return to its standard layout.

## Verification

Open a profile's media page and confirm that media items appear in a compact
gallery instead of full tweet cards. If the page remains a timeline, X has
either changed the relevant flags or removed the legacy component.

## License

Released under the [MIT License](LICENSE).
