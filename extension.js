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
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

import {
  Extension,
  gettext as _
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as GnomeSession from 'resource:///org/gnome/shell/misc/gnomeSession.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';


const extIpService = 'https://ipinfo.io/json';
const extIpServiceStaticMap = 'https://staticmap.thisipcan.cyou/';
const extCountryFlagService = 'https://flagicons.lipis.dev/flags/4x3/<countrycode>.svg';

let thisExtensionDir = ""; //Me.path

const timeout = 60; // be friendly, refresh every 10 mins.
const minTimeBetweenChecks = 4; //in seconds, to avoid network event induced IP re-checks occur too frequent
const networkEventRefreshTimeout = 4;



let IPdata = {
 "IP": null,
 "latitude": 0,
 "longitude": 0,
 "country": null,
 "countryCode": "unknown", // unknown.svg
 "city": null,
 "org": null
};

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {

    _init() {
      super._init(0.0, _('IP indicator'));

      this.flag_widget = new St.Button();
      this.flag_widget.set_style_class_name("notifyIcon");

      this.update();
      this.connect('button-press-event', this._onButtonClicked);
      this.flag_widget.connect('button-press-event', this._onButtonClicked);

      this.add_child(this.flag_widget);
    }


    update() {
      this.flag_widget.set_style(`background-image: url("${thisExtensionDir}/flags/${IPdata.countryCode.toLowerCase()}.svg");`);
      this.flag_widget.set_label(IPdata.IP);
    }


    _onButtonClicked(obj, e) {
      if (obj.menu == null) obj = obj.get_parent();
      obj.menu.removeAll();

      obj.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_("Click to copy to clipboard")));
      let copyTextFunction = function(item, event) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.label.text);
        return Clutter.EVENT_PROPAGATE;
      };


      let copyBtn = new PopupMenu.PopupImageMenuItem(_(IPdata.IP), getIcon("/img/ip_ed.svg"), {});
      copyBtn.connect('activate', copyTextFunction);
      obj.menu.addMenuItem(copyBtn);


      let orgBtn = new PopupMenu.PopupImageMenuItem(_(IPdata.org ?? ""), getIcon("/img/company.svg"), {});
      orgBtn.connect('activate', copyTextFunction);
      obj.menu.addMenuItem(orgBtn);


      let flagIcon = getIcon(`/flags/${IPdata.countryCode.toLowerCase()}.svg`);
      let countryBtn = new PopupMenu.PopupImageMenuItem(_(IPdata.country + " (" + IPdata.countryCode + "), " + IPdata.city), flagIcon, {});
      countryBtn.connect('activate', copyTextFunction);
      obj.menu.addMenuItem(countryBtn);

      let mapImageBtn = new PopupMenu.PopupMenuItem(_(""), {
        style_class: 'mapMenuItem'
      });
      mapImageBtn.set_style("background-image: url('" + thisExtensionDir + "/img/map.svg');");

      let mapsUrl = 'https://maps.google.com/maps?q=' + String(IPdata.latitude) + ',' + String(IPdata.longitude);

      mapImageBtn.connect('activate', function(item, event) {
        log(mapsUrl);
        GLib.spawn_command_line_async("xdg-open \"" + mapsUrl + "\"");
        return Clutter.EVENT_PROPAGATE;
      });

      obj.menu.addMenuItem(mapImageBtn);
      obj.menu.toggle();
      if (currentInstance) currentInstance.fetchData();
    }

});






function httpRequest(url, type = 'GET', callback) {
  let soupSession = Soup.Session.new();
  let message = Soup.Message.new(type, url);

  message.request_headers.set_content_type("application/json", null);
  soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, callback); //result.get_data(); //(new TextDecoder('utf-8')).decode( xx )
}




// Create GNOME Notification
let popup_icon = null;
let notificationSource = null;
function getNotificationSource() {
    if (!notificationSource) {
        notificationSource = new MessageTray.Source({
            title: _('Show Public IP'),
            icon: popup_icon,
            policy: new MessageTray.NotificationGenericPolicy(),
        });

        // Reset the notification source if it's destroyed
        notificationSource.connect('destroy', _source => {
            notificationSource = null;
        });
        Main.messageTray.add(notificationSource);
    }
    return notificationSource;
}

function notify(title, msg) {
  console.log("\n\nNotify!\n\n");
  const source = getNotificationSource();
  const notification = new MessageTray.Notification({
      source: source,
      title: title,
      body: msg,
  });
  source.addNotification(notification);
}


// Returns SVG as gicon
function getIcon(filepath) {
  let file = Gio.File.new_for_path(thisExtensionDir + filepath);
  return new Gio.FileIcon({
    file
  });
}




let currentInstance = null;
export default class ShowPublicIP extends Extension {

  constructor(metadata) {
    super(metadata);
    currentInstance = this;
    thisExtensionDir = this.path;
    this.disabled = true;
    this.isIdle = false;
    this.lastCheck = 0;
    this.network_monitor = null;
    this.network_monitor_connection = null;
    this.sourceLoopID = null;
    this.presence = null;
    this.presence_connection = null;
    this.networkEventRefreshLoopID = null;
    this.panelButton = null;
  }

  enable() {
    this.disabled = false;
    IPdata.IP = "???";

    // Initialize icon once to prevent unnecessary reloading, unload in disable.
    popup_icon = getIcon("/img/ip.svg");

    // Prepare UI
    this.messageTray = new MessageTray.MessageTray();

    if (this.panelButton == null) {
      this.panelButton = new Indicator();
    }

    // Add the button to the panel
    Main.panel.addToStatusArea(this.uuid, this.panelButton, 0, 'right');

    this.presence = new GnomeSession.Presence((proxy, error) => {
      this._onStatusChanged(proxy.status);
    });
    this.presence_connection = this.presence.connectSignal('StatusChanged', (proxy, senderName, [status]) => {
      this._onStatusChanged(status);
    });

    this.networkMonitorEnable();

    // After enabling, immediately get ip
    this.fetchData();

    // Enable timer
    this.timer();
  }


  disable() {
    // Set to true so if the timer hits, stop.
    this.disabled = true;
    popup_icon = null;
    this.messageTray = null;

    // clear UI widgets
    // Remove the added button from panel
    // bugfix: remove panelButton before setting to null
    Main.panel.remove_child(this.panelButton);
    this.panelButton.destroy();

    this.panelButton = null;

    this.presence.disconnectSignal(this.presence_connection);
    this.presence = null;

    this.networkMonitorDisable();

    // Remove timer loop altogether
    if (this.sourceLoopID) {
      GLib.Source.remove(this.sourceLoopID);
      this.sourceLoopID = null;
    }
  }


  fetchData() {
    //let t = new Date().getTime();
    //if (t - this.lastCheck <= minTimeBetweenChecks * 1000) return;
    //this.lastCheck = t;
    console.log("\n\nFetching...\n\n");

    httpRequest(extIpService, "GET", (_httpSession, result) => {
      try {
        let bytes = _httpSession.send_and_read_finish(result);
        let res = new TextDecoder('utf-8').decode(bytes.get_data());
        let data = JSON.parse(res);

        let IPhasChanged = (IPdata.IP != data.ip);
        if (IPhasChanged) console.log(data.ip);

        let lat = 0; let lon = 0;
        if(data.loc != null && data.loc.split(',').length == 2){
          lat = data.loc.split(',')[0];
          lon = data.loc.split(',')[1]
        }

        IPdata = {
         "IP": data.ip ?? "???",
         "latitude": lat,
         "longitude": lon,
         "country": data.region ?? "???",
         "countryCode": data.country ?? "???",
         "city": data.city ?? "???",
         "org": data.org ?? "???"
        };

        if(IPhasChanged){
          notify('Public IP Address has been changed to ' + IPdata.IP, '');
          currentInstance.updateIP();

          //Fetch map
          console.log("\n\nFetching map\n\n");
          let url_map = extIpServiceStaticMap + "?lat=" + IPdata.latitude + "&lon=" + IPdata.longitude + "&f=SVG&marker=12&w=250&h=150";
          httpRequest(url_map, "GET", (_httpSession, result) => {
            let bytes = _httpSession.send_and_read_finish(result);
            const file = Gio.File.new_for_path(thisExtensionDir + "/img/map.svg");
            const [, etag] = file.replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
          });

          //Fetch flag
          console.log("\n\nFetching flag\n\n");
          let url_flag = extCountryFlagService.replace("<countrycode>", IPdata.countryCode.toLowerCase());
          httpRequest(url_flag, "GET", (_httpSession, result) => {
            let bytes = _httpSession.send_and_read_finish(result);
            const file = Gio.File.new_for_path(`${thisExtensionDir}/flags/${IPdata.countryCode.toLowerCase()}.svg`);
            const [, etag] = file.replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            currentInstance.updateIP(); //update the flag
          });
        }

      } catch (e) {
        IPdata.IP = "No Internet";
        IPdata.countryCode = "unknown";
        IPdata.org = "404" ;
        currentInstance.updateIP();
        console.log("\n\nFailed Fetching\n\n");
        console.log(e);
        return;
      }
    });
  }

  updateIP() {
    if (this.panelButton != null) {
      this.panelButton.update();
    }
  }


  networkMonitorEnable() {
    // Enable network event monitoring
    this.network_monitor = Gio.NetworkMonitor.get_default();
    this.network_monitor_connection = this.network_monitor.connect('network-changed', this._onNetworkStatusChanged.bind(this));
  }


  networkMonitorDisable() {
    // Cleanup network monitor properly
    this.network_monitor.disconnect(this.network_monitor_connection);
    this.network_monitor = null;

    // Remove timer for network events
    if (this.networkEventRefreshLoopID) {
      GLib.Source.remove(this.networkEventRefreshLoopID);
      this.networkEventRefreshLoopID = null;
    }
  }


  // wait until time elapsed, to be friendly to external ip url
  timer() {
    if (this.disabled || this.isIdle) return;
    this.sourceLoopID = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, function() {
      currentInstance.fetchData();
      currentInstance.timer();
    });
  }


  // In case of GNOME event
  _onStatusChanged(status) {
    let backFromSleep = false;

    if (status == GnomeSession.PresenceStatus.IDLE) {
      this.isIdle = true;
      this.networkMonitorDisable();
    } else {
      if (this.isIdle) {
        backFromSleep = true;
      }
      this.isIdle = false;
      this.networkMonitorEnable();
    }

    if (backFromSleep) {
      if (this.sourceLoopID) {
        GLib.Source.remove(this.sourceLoopID);
        this.sourceLoopID = null;
      }
      this.timer();
    }
  }

  // In case of a network event, inquire external IP.
  _onNetworkStatusChanged(status = null) {
    if (status != null && !this.isIdle) {
      if (status.get_network_available()) {
        this.networkEventRefreshLoopID = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, networkEventRefreshTimeout, this.fetchData.bind(this));
      }
    }
  }
}
