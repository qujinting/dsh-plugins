# NOTICE

`dsh-desktop-pet` bundles and depends on material under several licences. The
plugin's own code is MIT; the rest is not, and the difference matters if you
redistribute or use this commercially.

## DS鲸鱼娘 — the Live2D model (`assets/pet/`, `icon.png`)

**CC BY-NC-SA 4.0** — attribution, **non-commercial**, share-alike.
Full text: <https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh>

| Role | Author | Link |
|---|---|---|
| 鲸鱼娘 character, original OC「溟月」 | 上善无形 | <https://www.pixiv.net/users/62155430> |
| DeepSeek-maid redesign | ZipZipPipe | <https://www.pixiv.net/users/18604994> |
| This Live2D model (rig, motions, expressions) | 氵六青 | <https://space.bilibili.com/11272072> |

The model's author authorised redistribution of this model with the plugin.
That authorisation **does not lift the base copyright**: the character design
was published by 上善无形 and ZipZipPipe under CC BY-NC-SA 4.0, so the
**NC and SA terms still apply**. Commercial use requires permission from each
rights holder separately.

If you fork this plugin, you must keep the attribution above, keep your
distribution non-commercial, and license your adaptation under the same terms.

## Live2D Cubism Core (`live2dcubismcore.min.js`)

**Proprietary** — Live2D Inc., under the Live2D Proprietary Software License
Agreement. It is deliberately **not** part of this package. The host half
fetches it once from Live2D's official CDN
(<https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js>) and
caches it under `$DSH_HOME/desktop-pet/.runtime/`. Downloading or using it is
subject to Live2D's own terms.

## Vendored rendering stack (`lib/live2d-vendor.js`)

A build of two MIT-licensed packages, both redistributable:

| Package | Version | Licence |
|---|---|---|
| [`pixi.js`](https://github.com/pixijs/pixijs) | 8.19.0 | MIT |
| [`untitled-pixi-live2d-engine`](https://github.com/Untitled-Story/untitled-pixi-live2d-engine) | 1.4.0 | MIT |

Rebuild it with `npm run build:vendor` from `src/vendor-entry.js`.
