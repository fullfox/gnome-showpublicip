/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as GnomeSession from 'resource:///org/gnome/shell/misc/gnomeSession.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const IP_SERVICE = 'https://ipinfo.io/json';
const FLAG_SERVICE = 'https://flagicons.lipis.dev/flags/4x3/<countrycode>.svg';

// Map: a few OpenStreetMap tiles stitched around the location.
// Usage policy: https://operations.osmfoundation.org/policies/tiles/
const TILE_SERVICE = 'https://tile.openstreetmap.org/<z>/<x>/<y>.png';
const TILE_SIZE = 256;
const MAP_ZOOM = 11; // ipinfo's location is city-level, no point zooming closer
const MAP_WIDTH = 250;
const MAP_HEIGHT = 150;
const USER_AGENT = 'gnome-shell-extension-showpublicip/1.0';

const REFRESH_INTERVAL = 600; // seconds between periodic checks (local changes are caught by NetworkMonitor)
const MIN_TIME_BETWEEN_CHECKS = 4; // seconds, throttles menu-open refreshes
const NETWORK_EVENT_DELAY = 4; // seconds, debounces network-changed bursts

function emptyIPData() {
    return {
        ip: '???',
        latitude: 0,
        longitude: 0,
        region: '',
        countryCode: 'unknown',
        city: '',
        org: '',
    };
}

function getIcon(path) {
    return new Gio.FileIcon({file: Gio.File.new_for_path(path)});
}

function fileExists(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR);
}

function isCancelled(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Slippy-map tiles needed to show a width x height view centred on lat/lon.
 * Each entry has the tile coordinates and where to draw it in the view.
 */
function mapTiles(lat, lon, zoom, width, height) {
    const n = 2 ** zoom;
    lat = Math.max(-85.05, Math.min(85.05, lat));
    const latRad = lat * Math.PI / 180;
    const xf = (lon + 180) / 360 * n;
    const yf = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const x0 = Math.floor(xf);
    const y0 = Math.floor(yf);

    // Position of tile (x0, y0) such that the point lands at the view centre.
    const ox = width / 2 - (xf - x0) * TILE_SIZE;
    const oy = height / 2 - (yf - y0) * TILE_SIZE;

    const tiles = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const px = ox + dx * TILE_SIZE;
            const py = oy + dy * TILE_SIZE;
            if (px + TILE_SIZE <= 0 || px >= width || py + TILE_SIZE <= 0 || py >= height)
                continue; // not visible
            const y = y0 + dy;
            if (y < 0 || y >= n)
                continue; // beyond the poles
            const x = ((x0 + dx) % n + n) % n; // wrap around the antimeridian
            tiles.push({z: zoom, x, y, px: Math.round(px), py: Math.round(py)});
        }
    }
    return tiles;
}


const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, _('IP indicator'));
        this._ext = ext;
        this._mapUri = null;

        // Purely visual: clicks go to the PanelMenu.Button, which opens the menu.
        this._flagWidget = new St.Button({
            style_class: 'notifyIcon',
            reactive: false,
            can_focus: false,
            track_hover: false,
        });
        this.add_child(this._flagWidget);

        this.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem(_('Click to copy to clipboard')));
        this._ipItem = this._addCopyItem(`${ext.path}/img/ip_ed.svg`);
        this._orgItem = this._addCopyItem(`${ext.path}/img/company.svg`);
        this._countryItem = this._addCopyItem(ext.flagPath('unknown'));

        this._buildMapItem();

        // Refresh when the menu is opened (throttled in fetchData).
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._ext.fetchData();
        });
    }

    _addCopyItem(iconPath) {
        const item = new PopupMenu.PopupImageMenuItem('', getIcon(iconPath));
        item.connect('activate', () => {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, item.label.text);
        });
        this.menu.addMenuItem(item);
        return item;
    }

    _buildMapItem() {
        this._mapItem = new PopupMenu.PopupBaseMenuItem({style_class: 'mapMenuItem'});
        this._mapItem.connect('activate', () => this._openMap());
        this._mapItem.visible = false;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._mapItem.add_child(box);

        // Tiles are placed at fixed positions and clipped to the view.
        this._mapView = new St.Widget({
            style_class: 'mapView',
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
            clip_to_allocation: true,
        });
        box.add_child(this._mapView);

        this._mapMarker = new St.Icon({
            style_class: 'mapMarker',
            icon_name: 'mark-location-symbolic',
            icon_size: 24,
        });
        // Pin tip at the view centre.
        this._mapMarker.set_position(MAP_WIDTH / 2 - 12, MAP_HEIGHT / 2 - 24);
        this._mapView.add_child(this._mapMarker);

        box.add_child(new St.Label({
            style_class: 'mapAttribution',
            text: '© OpenStreetMap contributors',
            x_align: Clutter.ActorAlign.END,
        }));

        this.menu.addMenuItem(this._mapItem);
    }

    _openMap() {
        if (!this._mapUri)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(
                this._mapUri, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`Show Public IP: cannot open map: ${e.message}`);
        }
    }

    update(data) {
        const flag = this._ext.flagPath(data.countryCode);

        this._flagWidget.set_style(`background-image: url("${flag}");`);
        this._flagWidget.set_label(data.ip);

        this._ipItem.label.text = data.ip;
        this._orgItem.label.text = data.org;
        this._countryItem.label.text =
            `${data.region} (${data.countryCode.toUpperCase()}), ${data.city}`;
        this._countryItem.setIcon(getIcon(flag));

        this._mapUri = data.latitude || data.longitude
            ? `https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}#map=${MAP_ZOOM}/${data.latitude}/${data.longitude}`
            : null;
    }

    /** tiles: [{path, px, py}], or an empty array to hide the map. */
    setMap(tiles) {
        for (const child of this._mapView.get_children()) {
            if (child !== this._mapMarker)
                child.destroy();
        }

        for (const {path, px, py} of tiles) {
            const tile = new St.Widget({
                width: TILE_SIZE,
                height: TILE_SIZE,
                style: `background-image: url("${path}"); background-size: ${TILE_SIZE}px ${TILE_SIZE}px;`,
            });
            tile.set_position(px, py);
            this._mapView.add_child(tile);
        }
        this._mapView.set_child_above_sibling(this._mapMarker, null);
        this._mapItem.visible = tiles.length > 0;
    }
});


export default class ShowPublicIP extends Extension {
    enable() {
        this._data = emptyIPData();
        this._lastKnownIP = null; // last IP successfully fetched this session
        this._session = new Soup.Session({timeout: 15, user_agent: USER_AGENT});
        this._cancellable = new Gio.Cancellable();
        this._fetching = null;
        this._lastCheck = 0;
        this._isIdle = false;
        this._refreshId = 0;
        this._networkRefreshId = 0;
        this._notificationSource = null;

        // Downloaded files go to the cache dir: the extension dir may be
        // read-only (system install) and should not be written to anyway.
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'showpublicip']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._indicator.update(this._data);

        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect(
            'network-changed', (_monitor, available) => this._onNetworkChanged(available));

        this._presence = new GnomeSession.Presence((proxy, error) => {
            if (!error && this._presence)
                this._onStatusChanged(proxy.status);
        });
        this._presenceId = this._presence.connectSignal(
            'StatusChanged', (_proxy, _sender, [status]) => this._onStatusChanged(status));

        this.fetchData(true);
        this._startTimer();
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;

        this._stopTimer();
        this._cancelNetworkRefresh();

        if (this._networkMonitor && this._networkChangedId)
            this._networkMonitor.disconnect(this._networkChangedId);
        this._networkChangedId = 0;
        this._networkMonitor = null;

        if (this._presence && this._presenceId)
            this._presence.disconnectSignal(this._presenceId);
        this._presenceId = 0;
        this._presence = null;

        this._notificationSource?.destroy();
        this._notificationSource = null;

        // addToStatusArea wraps the button in a container; destroy() cleans it up.
        this._indicator?.destroy();
        this._indicator = null;

        this._session?.abort();
        this._session = null;
        this._fetching = null;
        this._data = null;
    }

    // ---- Paths ------------------------------------------------------------

    flagPath(countryCode) {
        const name = `${countryCode.toLowerCase()}.svg`;
        for (const path of [
            `${this._cacheDir}/${name}`,
            `${this.path}/flags/${name}`,
        ]) {
            if (fileExists(path))
                return path;
        }
        return `${this.path}/flags/unknown.svg`;
    }

    _tilePath({z, x, y}) {
        return `${this._cacheDir}/tile_${z}_${x}_${y}.png`;
    }

    /** Remove cached tiles other than the ones in use. */
    _pruneTiles(keep) {
        const keepNames = new Set(keep.map(t => GLib.path_get_basename(this._tilePath(t))));
        try {
            const dir = GLib.Dir.open(this._cacheDir, 0);
            let name;
            while ((name = dir.read_name()) !== null) {
                if (name.startsWith('tile_') && !keepNames.has(name))
                    GLib.unlink(`${this._cacheDir}/${name}`);
            }
            dir.close();
        } catch (e) {
            console.warn(`Show Public IP: cannot prune tile cache: ${e.message}`);
        }
    }

    // ---- Networking -------------------------------------------------------

    async _get(url) {
        const message = Soup.Message.new('GET', url);
        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()} for ${url}`);
        return bytes;
    }

    async _download(url, path) {
        if (fileExists(path))
            return;
        const bytes = await this._get(url);
        await Gio.File.new_for_path(path).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
            this._cancellable);
    }

    fetchData(force = false) {
        if (!this._session)
            return;

        // One request at a time: a second caller just joins the one in flight.
        if (this._fetching)
            return;

        const now = GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
        if (!force && now - this._lastCheck < MIN_TIME_BETWEEN_CHECKS)
            return;
        this._lastCheck = now;

        this._fetching = this._doFetch().finally(() => {
            this._fetching = null;
        });
    }

    async _doFetch() {
        let json;
        try {
            const bytes = await this._get(IP_SERVICE);
            json = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));
        } catch (e) {
            if (isCancelled(e) || !this._session)
                return;
            console.warn(`Show Public IP: fetch failed: ${e.message}`);
            this._data = {...emptyIPData(), ip: _('No Internet'), org: '404'};
            this._indicator.update(this._data);
            this._indicator.setMap([]);
            return;
        }
        if (!this._session)
            return;

        let lat = 0, lon = 0;
        const loc = (json.loc ?? '').split(',').map(Number);
        if (loc.length === 2 && loc.every(Number.isFinite))
            [lat, lon] = loc;

        // Only trust a plain 2-letter code (it ends up in a file path).
        const cc = /^[a-z]{2}$/i.test(json.country ?? '')
            ? json.country.toLowerCase()
            : 'unknown';

        this._data = {
            ip: String(json.ip ?? '???'),
            latitude: lat,
            longitude: lon,
            region: json.region ?? '???',
            countryCode: cc,
            city: json.city ?? '???',
            org: json.org ?? '???',
        };
        this._indicator.update(this._data);

        // Compare against the last *successful* fetch, so a transient outage
        // ("No Internet") does not trigger a bogus "IP changed" afterwards.
        if (this._lastKnownIP === this._data.ip)
            return;
        const firstFetch = this._lastKnownIP === null;
        this._lastKnownIP = this._data.ip;

        if (!firstFetch)
            this._notify(_('Public IP Address has been changed to %s').format(this._data.ip));

        const tiles = lat || lon
            ? mapTiles(lat, lon, MAP_ZOOM, MAP_WIDTH, MAP_HEIGHT)
            : [];
        const downloads = tiles.map(t => this._download(
            TILE_SERVICE.replace('<z>', t.z).replace('<x>', t.x).replace('<y>', t.y),
            this._tilePath(t)));

        if (cc !== 'unknown' && this.flagPath(cc).endsWith('/unknown.svg')) {
            downloads.push(this._download(
                FLAG_SERVICE.replace('<countrycode>', cc),
                `${this._cacheDir}/${cc}.svg`));
        }

        const results = await Promise.allSettled(downloads);
        if (!this._session || this._data.ip !== this._lastKnownIP)
            return; // disabled, or a newer fetch has taken over

        for (const r of results) {
            if (r.status === 'rejected' && !isCancelled(r.reason))
                console.warn(`Show Public IP: download failed: ${r.reason.message}`);
        }

        // Only show the map if every tile made it; a partial map looks broken.
        const tilesOk = tiles.length > 0 &&
            results.slice(0, tiles.length).every(r => r.status === 'fulfilled');
        this._indicator.setMap(tilesOk
            ? tiles.map(t => ({path: this._tilePath(t), px: t.px, py: t.py}))
            : []);
        if (tilesOk)
            this._pruneTiles(tiles);

        this._indicator.update(this._data); // picks up a freshly downloaded flag
    }

    // ---- Notifications ----------------------------------------------------

    _notify(title, body = '') {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: _('Show Public IP'),
                icon: getIcon(`${this.path}/img/ip.svg`),
                policy: new MessageTray.NotificationGenericPolicy(),
            });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }

        this._notificationSource.addNotification(new MessageTray.Notification({
            source: this._notificationSource,
            title,
            body,
        }));
    }

    // ---- Timers and events ------------------------------------------------

    _startTimer() {
        this._stopTimer();
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL, () => {
                this.fetchData(true);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimer() {
        if (this._refreshId) {
            GLib.Source.remove(this._refreshId);
            this._refreshId = 0;
        }
    }

    _cancelNetworkRefresh() {
        if (this._networkRefreshId) {
            GLib.Source.remove(this._networkRefreshId);
            this._networkRefreshId = 0;
        }
    }

    _onStatusChanged(status) {
        const idle = status === GnomeSession.PresenceStatus.IDLE;
        if (idle === this._isIdle)
            return;
        this._isIdle = idle;

        if (idle) {
            this._stopTimer();
            this._cancelNetworkRefresh();
        } else {
            // Back from idle/sleep: check right away, then resume polling.
            this.fetchData(true);
            this._startTimer();
        }
    }

    _onNetworkChanged(available) {
        if (this._isIdle || !available)
            return;

        // Debounce: network-changed often fires several times in a row.
        this._cancelNetworkRefresh();
        this._networkRefreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, NETWORK_EVENT_DELAY, () => {
                this._networkRefreshId = 0;
                this.fetchData(true);
                return GLib.SOURCE_REMOVE;
            });
    }
}