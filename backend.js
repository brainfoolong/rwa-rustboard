"use strict";

var Widget = require(__dirname + "/../../../src/widget");
var steamapi = require(__dirname + "/../../../src/steamapi");

var widget = new Widget();

/** @type {object} */
widget.serverstatus = {};

/**
 * On rcon server has successfully connected and authenticated
 * @param {RconServer} server
 */
widget.onServerConnected = function (server) {
    widget.updateServerstatus(server);
    // set settings on boot
    var settings = widget.storage.get(server, "serversettings");
    if (settings && settings.setOnBoot) {
        for (var settingsIndex in settings) {
            if (settings.hasOwnProperty(settingsIndex)) {
                var settingsRow = settings[settingsIndex];
                if (settingsIndex == "setOnBoot" || settingsRow.dbValue === null) continue;
                server.cmd(settingsIndex + ' "' + settingsRow.cmdValue + '"');
            }
        }
        // update serverstatus after we've set all settings
        setTimeout(function () {
            widget.updateServerstatus(server);
        }, 2000);
    }
};

/**
 * Fired when widget is added to a server dashboard
 * @param {RconServer} server
 */
widget.onWidgetAdded = function (server) {
    widget.updateServerstatus(server);
};

/**
 * On frontend message
 * @param {RconServer} server
 * @param {WebSocketUser} user
 * @param {string} action The action
 * @param {*} messageData Any message data received from frontend
 * @param {function} callback Pass an object as message data response for the frontend
 */
widget.onFrontendMessage = function (server, user, action, messageData, callback) {
    switch (action) {
        case "serverstatus":
            if (messageData.forceUpdate) {
                widget.updateServerstatus(server, function () {
                    callback(widget, widget.serverstatus[server.id]);
                });
            } else {
                callback(widget, widget.serverstatus[server.id]);
            }
            break;
    }
};

/**
 * Update the serverstatus
 * @param {RconServer} server
 * @param {function=} callback
 */
widget.updateServerstatus = function (server, callback) {
    server.cmd("status", null, false, function (statusData) {
        if (!statusData) statusData = "";
        var statusDataLines = statusData.split("\n");
        if (!statusDataLines || statusDataLines.length < 3) {
            if (callback) callback();
            return;
        }
        var hostname = statusDataLines[0].split(":").slice(1);
        var version = statusDataLines[1].split(":").slice(1);
        var map = statusDataLines[2].split(":").slice(1);
        var players = statusDataLines[3].split(":").slice(1);

        var newStatus = {
            "server": {
                "hostname": hostname ? hostname.join(":").trim() : "",
                "players": players ? players.join(":").trim() : "",
                "version": version ? version.join(":").trim() : "",
                "map": map ? map.join(":").trim() : ""
            },
            "players": {
                "onlineCount": 0,
                "bannedCount": 0,
                "online": {},
                "banned": {}
            }
        };
        server.cmd("playerlist", null, false, function (playerlistData) {
            var playerlist = [];
            try {
                playerlist = JSON.parse(playerlistData);
            } catch (e) {
            }
            var playerlistObject = {};
            var ids = [];
            for (var i = 0; i < playerlist.length; i++) {
                var player = playerlist[i];
                var playerLower = {};
                for (var playerIndex in player) {
                    if (player.hasOwnProperty(playerIndex)) {
                        playerLower[playerIndex.toLowerCase()] = player[playerIndex];
                    }
                }
                playerLower.vacstatus = {};
                playerlistObject[playerLower.steamid] = playerLower;
                ids.push(playerLower.steamid);
            }
            newStatus.players.onlineCount = playerlist.length;
            newStatus.players.online = playerlistObject;
            steamapi.request("bans", ids, function (banStatus) {
                for (var banIndex in banStatus) {
                    if (banStatus.hasOwnProperty(banIndex)) {
                        var banRow = banStatus[banIndex];
                        var status = "ok";
                        var newBanRow = {};
                        for (var steamIndex in banRow) {
                            if (banRow.hasOwnProperty(steamIndex)) {
                                var steamValue = banRow[steamIndex];
                                steamIndex = steamIndex.toLowerCase();
                                if (steamIndex == "economyban") steamValue = steamValue != "none";
                                if (steamIndex != "timestamp" && steamIndex != "steamid" && steamValue) {
                                    status = "suspicious";
                                }
                                newBanRow[steamIndex] = steamValue;
                            }
                        }
                        newBanRow.status = status;
                        newStatus.players.online[newBanRow.steamid].vacstatus = newBanRow;
                    }
                }

                // get bans from server
                server.cmd("bans", null, false, function (messageData) {
                    if (messageData) {
                        // fix for 64bit integer
                        messageData = messageData.replace(/(\"steamid\"\s*:\s*)([0-9]+)/g, function (all) {
                            return all.replace(/[0-9]+/, "\"$&\"")
                        });
                        try {
                            var bans = JSON.parse(messageData);
                            newStatus.players.bannedCount = bans.length;
                            for (var i = 0; i < bans.length; i++) {
                                newStatus.players.banned[bans[i].steamid] = bans[i];
                            }
                        } catch (e) {

                        }
                    }
                    newStatus.timestamp = new Date();
                    widget.serverstatus[server.id] = newStatus;
                    if (callback) callback();
                    widget.sendMessageToFrontend(server, {"serverstatus": true});
                });
            });
        });
    });
};

/**
 * On widget update cycle - Fired every 30 seconds for each server
 * @param {RconServer} server
 */
widget.onUpdate = function (server) {
    var now = new Date().getTime() / 1000;
    // only update serverstatus each 2 minutes
    if (!widget.serverstatus[server.id] || widget.serverstatus[server.id].timestamp.getTime() / 1000 < now - 120) {
        widget.updateServerstatus(server);
    }
    var lastpingCheck = widget.storage.get(server, "lastpingcheck") || 0;
    var pingCheckEnabled = lastpingCheck < now - 300;
    if (pingCheckEnabled) {
        widget.storage.set(server, "lastpingcheck", now);
    }
    if (widget.serverstatus[server.id]) {
        for (var playerIndex in widget.serverstatus[server.id].players.online) {
            if (widget.serverstatus[server.id].players.online.hasOwnProperty(playerIndex)) {
                var player = widget.serverstatus[server.id].players.online[playerIndex];
                // check for high pings every 5 minutes
                if (pingCheckEnabled) {
                    var pingMax = widget.options.get(server, "kickping");
                    var pingWarn = widget.options.get(server, "kickpingWarn")
                    if (pingMax > 0) {
                        if (player.ping > pingMax) {
                            var pingCount = widget.storage.get(server, "pingcount." + player.steamid) || 0;
                            pingCount++;
                            if (pingCount > pingWarn) {
                                pingCount = null;
                                server.cmd("kick " + player.steamid + " \"Automatic kick -> Ping to high (max." + pingMax + ")\"");
                                server.cmd("say Kicked player " + player.displayname + ": High ping");
                            } else {
                                server.cmd("say High ping warning (" + pingCount + " of " + pingWarn + ") for player " + player.displayname + ". Your ping is " + player.ping + " (max. " + pingMax + ")");
                            }
                            widget.storage.set(server, "pingcount." + player.steamid, pingCount, 300);
                        } else {
                            widget.storage.set(server, "pingcount." + player.steamid, null);
                        }
                    }
                }
                // check for vac
                var vacMax = widget.options.get(server, "kickvac");
                if (vacMax >= 0 && player.vacstatus && player.vacstatus.numberofvacbans > vacMax) {
                    server.cmd("kick " + player.steamid + " \"Automatic kick -> " + vacMax + " VAC Bans\"");
                    server.cmd("say Kicked player " + player.displayname + ": " + vacMax + " VAC Bans");
                }
            }
        }
    }
};

/**
 * On receive a server message
 * @param {RconServer} server
 * @param {RconMessage} message
 */
widget.onServerMessage = function (server, message) {
    // on connect or disconnect, update serverstatus
    if (message.body.match(/([0-9\.]+)\/([0-9]+)\/(.*?) (joined|disconnect)/i)) {
        widget.updateServerstatus(server);
        return;
    }
    var chatFilter = widget.options.get(server, "kickchat");
    var chatMsg = message.body.match(/^\[CHAT\] (.*?)\[([0-9]+)\/([0-9]+)\] \: (.*)/i);
    if (chatFilter && chatMsg) {
        var words = chatFilter.split(",");
        var found = false;
        for (var i = 0; i < words.length; i++) {
            var word = words[i].trim();
            if (word) {
                if (chatMsg[4].match(new RegExp(word, "i"))) {
                    found = word;
                    break;
                }
            }
        }
        if (found !== false) {
            var steamid = chatMsg[3];
            var chatMax = widget.options.get(server, "kickchatWarn");
            var chatCount = widget.storage.get(server, "chatcount." + steamid) || 0;
            chatCount++;
            if (chatCount > chatMax) {
                chatCount = null;
                server.cmd("kick " + steamid + " \"Automatic kick -> Chat filter\"");
                server.cmd("say Kicked player " + chatMsg[1] + ": Chat abuse");
            } else {
                server.cmd("say " + chatMsg[1] + " you've violated our chat filter rule '" + found + "'. Warning " + chatCount + " of " + chatMax);
            }
            widget.storage.set(server, "chatcount." + steamid, chatCount, 300);
        }
        return;
    }
}

module.exports = widget;