/**
 * Draws every plant scheme of the IDM manuals with the heat pump diagram page, to review the diagram against all of them: writes a
 * folder with the page (copied from `www/`), a data snapshot per scheme and an overview `gallery.html` that shows one screenshot
 * per scheme (the screenshots are made separately, see `--shots`).
 *
 * Usage: `npx ts-node tools/build-gallery.ts <folder> [language]`, then serve the folder with any static web server and open
 * `gallery.html` (or `index.html?scenario=<scheme id>` for one scheme). Development tool: reads the manual-derived
 * `tools/sources/diagram-schemes.json`, nothing of it ships with the adapter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSnapshot, canCool, hasHotWater, loadSchemes, MODE } from './diagram-fixtures';

const root = path.join(__dirname, '..');

/** The data layer of the page, replaced by one that serves the snapshots. */
const DATA_STUB = `(function (root) {
    root.DiagramData = {
        connect: function (options, handlers) {
            var name = new URLSearchParams(location.search).get('scenario') || '';
            fetch('snapshots/' + name + '.json')
                .then(function (r) { return r.json(); })
                .then(function (snapshot) {
                    handlers.onConnection(true);
                    handlers.onSnapshot(snapshot);
                });
        },
    };
})(window);
`;

/**
 * Write the gallery.
 *
 * @param folder output folder
 * @param language language of the pages
 */
export function buildGallery(folder: string, language: string): number {
    fs.mkdirSync(path.join(folder, 'snapshots'), { recursive: true });
    for (const file of fs.readdirSync(path.join(root, 'www'))) {
        if (file !== 'data.js' && fs.statSync(path.join(root, 'www', file)).isFile()) {
            fs.copyFileSync(path.join(root, 'www', file), path.join(folder, file));
        }
    }
    fs.writeFileSync(path.join(folder, 'data.js'), DATA_STUB);
    const schemes = loadSchemes();
    const cards: string[] = [];
    for (const scheme of schemes) {
        // the plant in the mode the manual scheme shows, again while it cools (if it can) and while it charges the hot water vessel
        const variants = [
            { suffix: '', mode: MODE.heating, drawn: true },
            { suffix: '-cooling', mode: MODE.cooling, drawn: canCool(scheme) },
            { suffix: '-dhw', mode: MODE.hotWater, drawn: hasHotWater(scheme) },
        ].filter(variant => variant.drawn);
        for (const variant of variants) {
            fs.writeFileSync(
                path.join(folder, 'snapshots', `${scheme.id}${variant.suffix}.json`),
                JSON.stringify(buildSnapshot(scheme, language, variant.mode)),
            );
        }
        const heading = [scheme.unit, scheme.code].filter(Boolean).join(' · ');
        const pictures = variants
            .map(
                variant =>
                    `<a href="index.html?scenario=${scheme.id}${variant.suffix}"><img loading="lazy" src="shots/${scheme.id}${variant.suffix}.png" alt=""></a>`,
            )
            .join('');
        cards.push(
            `<figure>${pictures}` +
                `<figcaption><b>${heading}</b><br>${scheme.title}<br><small>${scheme.manual}, page ${scheme.page}` +
                `${scheme.storage === 'separate' ? ' · two vessels' : ''}</small></figcaption></figure>`,
        );
    }
    fs.writeFileSync(
        path.join(folder, 'gallery.html'),
        `<!doctype html><meta charset="utf-8"><title>Diagram gallery</title><style>` +
            `body{font:14px system-ui,sans-serif;margin:16px;background:#f4f5f7}` +
            `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:16px}` +
            `figure{margin:0;background:#fff;border:1px solid #ccd;border-radius:8px;padding:8px}` +
            `img{width:100%;height:auto;display:block}figcaption{margin-top:6px}</style>` +
            `<h1>Diagram gallery: ${schemes.length} schemes of the IDM manuals</h1><div class="grid">${cards.join('')}</div>`,
    );
    return schemes.length;
}

if (require.main === module) {
    const folder = process.argv[2];
    if (!folder) {
        console.error('Usage: npx ts-node tools/build-gallery.ts <folder> [language]');
        process.exit(1);
    }
    console.log(`${buildGallery(path.resolve(folder), process.argv[3] || 'en')} schemes written to ${folder}`);
}
