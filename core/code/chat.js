/**
 * @file Namespace for chat-related functionalities.
 * @namespace window.chat
 */

window.chat = function () {};
var chat = window.chat;

/**
 * Handles tab completion in chat input.
 *
 * @function chat.handleTabCompletion
 */
chat.handleTabCompletion = function() {
  var el = $('#chatinput input');
  var curPos = el.get(0).selectionStart;
  var text = el.val();
  var word = text.slice(0, curPos).replace(/.*\b([a-z0-9-_])/, '$1').toLowerCase();

  var list = $('#chat > div:visible mark');
  list = list.map(function(ind, mark) { return $(mark).text(); } );
  list = window.uniqueArray(list);

  var nick = null;
  for(var i = 0; i < list.length; i++) {
    if(!list[i].toLowerCase().startsWith(word)) continue;
    if(nick && nick !== list[i]) {
      log.warn('More than one nick matches, aborting. ('+list[i]+' vs '+nick+')');
      return;
    }
    nick = list[i];
  }
  if(!nick) {
    return;
  }

  var posStart = curPos - word.length;
  var newText = text.substring(0, posStart);
  var atPresent = text.substring(posStart-1, posStart) === '@';
  newText += (atPresent ? '' : '@') + nick + ' ';
  newText += text.substring(curPos);
  el.val(newText);
}

//
// clear management
//

chat._oldBBox = null;

/**
 * Generates post data for chat requests.
 *
 * @function chat.genPostData
 * @param {string} channel - The chat channel.
 * @param {Object} storageHash - Storage hash for the chat.
 * @param {boolean} getOlderMsgs - Flag to determine if older messages are being requested.
 * @returns {Object} The generated post data.
 */
chat.genPostData = function(channel, _storageHash, getOlderMsgs) {
  if (typeof channel !== 'string') {
    throw new Error('API changed: isFaction flag now a channel string - all, faction, alerts');
  }

  var b = window.clampLatLngBounds(map.getBounds());

  // set a current bounding box if none set so far
  if (!chat._oldBBox) chat._oldBBox = b;

  // to avoid unnecessary chat refreshes, a small difference compared to the previous bounding box
  // is not considered different
  var CHAT_BOUNDINGBOX_SAME_FACTOR = 0.1;
  // if the old and new box contain each other, after expanding by the factor, don't reset chat
  if (!(b.pad(CHAT_BOUNDINGBOX_SAME_FACTOR).contains(chat._oldBBox) && chat._oldBBox.pad(CHAT_BOUNDINGBOX_SAME_FACTOR).contains(b))) {
    log.log('Bounding Box changed, chat will be cleared (old: '+chat._oldBBox.toBBoxString()+'; new: '+b.toBBoxString()+')');

    // need to reset these flags now because clearing will only occur
    // after the request is finished – i.e. there would be one almost
    // useless request.
    chat.channels.forEach(function (entry) {
      if (entry.localBounds) {
        chat.initChannelData(entry);
        $('#chat' + entry.id).data('needsClearing', true);
      }
    });

    chat._oldBBox = b;
  }

  var storageHash = chat._channels[channel];

  var ne = b.getNorthEast();
  var sw = b.getSouthWest();
  var data = {
    minLatE6: Math.round(sw.lat*1E6),
    minLngE6: Math.round(sw.lng*1E6),
    maxLatE6: Math.round(ne.lat*1E6),
    maxLngE6: Math.round(ne.lng*1E6),
    minTimestampMs: -1,
    maxTimestampMs: -1,
    tab: channel,
  };

  if (getOlderMsgs) {
    // ask for older chat when scrolling up
    data = $.extend(data, {
      maxTimestampMs: storageHash.oldestTimestamp,
      plextContinuationGuid: storageHash.oldestGUID
    });
  } else {
    // ask for newer chat
    var min = storageHash.newestTimestamp;
    // the initial request will have both timestamp values set to -1,
    // thus we receive the newest 50. After that, we will only receive
    // messages with a timestamp greater or equal to min above.
    // After resuming from idle, there might be more new messages than
    // desiredNumItems. So on the first request, we are not really up to
    // date. We will eventually catch up, as long as there are less new
    // messages than 50 per each refresh cycle.
    // A proper solution would be to query until no more new results are
    // returned.
    // Currently this edge case is not handled. Let’s see if this is a
    // problem in crowded areas.
    $.extend(data, {
      minTimestampMs: min,
      plextContinuationGuid: storageHash.newestGUID
    });
    // when requesting with an actual minimum timestamp, request oldest rather than newest first.
    // this matches the stock intel site, and ensures no gaps when continuing after an extended idle period
    if (min > -1) $.extend(data, {ascendingTimestampOrder: true});
  }
  return data;
};

chat._requestRunning = {}
chat.requestChannel = function (channel, getOlderMsgs, isRetry) {
  if(chat._requestRunning[channel] && !isRetry) return;
  if(window.isIdle()) return window.renderUpdateStatus();
  chat._requestRunning[channel] = true;
  $("#chatcontrols a[data-channel='" + channel + "']").addClass('loading');

  var d = chat.genPostData(channel, chat._channels[channel], getOlderMsgs);
  var r = window.postAjax(
    'getPlexts',
    d,
    function(data, textStatus, jqXHR) { chat.handleChannel(channel, data, getOlderMsgs, d.ascendingTimestampOrder); },
    isRetry
      ? function() { chat._requestRunning[channel] = false; }
      : function() { chat.requestChannel(channel, getOlderMsgs, true) }
  );
};

chat.handleChannel = function (channel, data, olderMsgs, ascendingTimestampOrder) {
  chat._requestRunning[channel] = false;
  $("#chatcontrols a[data-channel='" + channel + "']").removeClass('loading');

  if(!data || !data.result) {
    window.failedRequestCount++;
    return log.warn(channel + ' chat error. Waiting for next auto-refresh.');
  }

  if (!data.result.length && !$('#chat'+channel).data('needsClearing')) {
    // no new data and current data in chat._faction.data is already rendered
    return;
  }

  $('#chat'+channel).data('needsClearing', null);

  var old = chat._channels[channel].oldestGUID;
  chat.writeDataToHash(data, chat._channels[channel], false, olderMsgs, ascendingTimestampOrder);
  var oldMsgsWereAdded = old !== chat._channels[channel].oldestGUID;

  var hook = channel + 'ChatDataAvailable';
  // backward compability
  if (channel === 'all') hook = 'publicChatDataAvailable';
  window.runHooks(hook, {raw: data, result: data.result, processed: chat._channels[channel].data});

  // generic hook
  window.runHooks('chatDataAvailable', {channel: channel, raw: data, result: data.result, processed: chat._channels[channel].data});

  chat.renderChannel(channel, oldMsgsWereAdded);
};

chat.renderChannel = function(channel, oldMsgsWereAdded) {
  chat.renderData(chat._channels[channel].data, 'chat' + channel, oldMsgsWereAdded, chat._channels[channel].guids);
}

//
// faction
//

/**
 * Requests faction chat messages.
 *
 * @function chat.requestFaction
 * @param {boolean} getOlderMsgs - Flag to determine if older messages are being requested.
 * @param {boolean} [isRetry=false] - Flag to indicate if this is a retry attempt.
 */
chat.requestFaction = function(getOlderMsgs, isRetry) {
  return chat.requestChannel('faction', getOlderMsgs, isRetry);
};

/**
 * Handles faction chat response.
 *
 * @function chat.handleFaction
 * @param {Object} data - Response data from server.
 * @param {boolean} olderMsgs - Indicates if older messages were requested.
 * @param {boolean} ascendingTimestampOrder - Indicates if messages are in ascending timestamp order.
 */
chat.handleFaction = function(data, olderMsgs, ascendingTimestampOrder) {
  return chat.handleChannel('faction', data, olderMsgs, ascendingTimestampOrder);
};

/**
 * Renders faction chat.
 *
 * @function chat.renderFaction
 * @param {boolean} oldMsgsWereAdded - Indicates if old messages were added in the current rendering.
 */
chat.renderFaction = function(oldMsgsWereAdded) {
  return chat.renderChannel('faction', oldMsgsWereAdded);
};


//
// all
//

/**
 * Initiates a request for public chat data.
 *
 * @function chat.requestPublic
 * @param {boolean} getOlderMsgs - Whether to retrieve older messages.
 * @param {boolean} [isRetry=false] - Whether the request is a retry.
 */
chat.requestPublic = function(getOlderMsgs, isRetry) {
  return chat.requestChannel('all', getOlderMsgs, isRetry);
};

/**
 * Handles the public chat data received from the server.
 *
 * @function chat.handlePublic
 * @param {Object} data - The public chat data.
 * @param {boolean} olderMsgs - Whether the received messages are older.
 * @param {boolean} ascendingTimestampOrder - Whether messages are in ascending timestamp order.
 */
chat.handlePublic = function(data, olderMsgs, ascendingTimestampOrder) {
  return chat.handleChannel('all', data, olderMsgs, ascendingTimestampOrder);
};

/**
 * Renders public chat in the UI.
 *
 * @function chat.renderPublic
 * @param {boolean} oldMsgsWereAdded - Indicates if older messages were added to the chat.
 */
chat.renderPublic = function(oldMsgsWereAdded) {
  return chat.renderChannel('all', oldMsgsWereAdded);
};


//
// alerts
//

/**
 * Initiates a request for alerts chat data.
 *
 * @function chat.requestAlerts
 * @param {boolean} getOlderMsgs - Whether to retrieve older messages.
 * @param {boolean} [isRetry=false] - Whether the request is a retry.
 */
chat.requestAlerts = function(getOlderMsgs, isRetry) {
  return chat.requestChannel('alerts', getOlderMsgs, isRetry);
};

/**
 * Handles the alerts chat data received from the server.
 *
 * @function chat.handleAlerts
 * @param {Object} data - The alerts chat data.
 * @param {boolean} olderMsgs - Whether the received messages are older.
 * @param {boolean} ascendingTimestampOrder - Whether messages are in ascending timestamp order.
 */
chat.handleAlerts = function(data, olderMsgs, ascendingTimestampOrder) {
  return chat.handleChannel('alerts', data, olderMsgs, ascendingTimestampOrder);
};

/**
 * Renders alerts chat in the UI.
 *
 * @function chat.renderAlerts
 * @param {boolean} oldMsgsWereAdded - Indicates if older messages were added to the chat.
 */
chat.renderAlerts = function(oldMsgsWereAdded) {
  return chat.renderChannel('alerts', oldMsgsWereAdded);
};


//
// common
//

/**
 * Adds a nickname to the chat input.
 *
 * @function chat.addNickname
 * @param {string} nick - The nickname to add.
 */
chat.addNickname= function(nick) {
  var c = document.getElementById("chattext");
  c.value = [c.value.trim(), nick].join(" ").trim() + " ";
  c.focus()
}

/**
 * Handles click events on nicknames in the chat.
 *
 * @function chat.nicknameClicked
 * @param {Event} event - The click event.
 * @param {string} nickname - The clicked nickname.
 * @returns {boolean} Always returns false.
 */
chat.nicknameClicked = function(event, nickname) {
  // suppress @ if coming from chat
  if (nickname.startsWith('@')) {
    nickname = nickname.slice(1);
  }
  var hookData = { event: event, nickname: nickname };

  if (window.runHooks('nicknameClicked', hookData)) {
    chat.addNickname('@' + nickname);
  }

  event.preventDefault();
  event.stopPropagation();
  return false;
}

/**
 * Updates the oldest and newest message timestamps and GUIDs in the chat storage.
 *
 * @function chat.updateOldNewHash
 * @param {Object} newData - The new chat data received.
 * @param {Object} storageHash - The chat storage object.
 * @param {boolean} isOlderMsgs - Whether the new data contains older messages.
 * @param {boolean} isAscendingOrder - Whether the new data is in ascending order.
 */
chat.updateOldNewHash = function(newData, storageHash, isOlderMsgs, isAscendingOrder) {
  // track oldest + newest timestamps/GUID
  if (newData.result.length > 0) {
    var first = {
      guid: newData.result[0][0],
      time: newData.result[0][1]
    };
    var last = {
      guid: newData.result[newData.result.length-1][0],
      time: newData.result[newData.result.length-1][1]
    };
    if (isAscendingOrder) {
      var temp = first;
      first = last;
      last = temp;
    }
    if (storageHash.oldestTimestamp === -1 || storageHash.oldestTimestamp >= last.time) {
      if (isOlderMsgs || storageHash.oldestTimestamp !== last.time) {
        storageHash.oldestTimestamp = last.time;
        storageHash.oldestGUID = last.guid;
      }
    }
    if (storageHash.newestTimestamp === -1 || storageHash.newestTimestamp <= first.time) {
      if (!isOlderMsgs || storageHash.newestTimestamp !== first.time) {
        storageHash.newestTimestamp = first.time;
        storageHash.newestGUID = first.guid;
      }
    }
  }
};

/**
 * Parses chat message data into a more convenient format.
 *
 * @function chat.parseMsgData
 * @param {Object} data - The raw chat message data.
 * @returns {Object} The parsed chat message data.
 */
chat.parseMsgData = function (data) {
  var categories = data[2].plext.categories;
  var isPublic = (categories & 1) === 1;
  var isSecure = (categories & 2) === 2;
  var msgAlert = (categories & 4) === 4;

  var msgToPlayer = msgAlert && (isPublic || isSecure);

  var time = data[1];
  var team = window.teamStringToId(data[2].plext.team);
  var auto = data[2].plext.plextType !== 'PLAYER_GENERATED';
  var systemNarrowcast = data[2].plext.plextType === 'SYSTEM_NARROWCAST';

  var markup = data[2].plext.markup;

  var player = {
    name: '',
    team: team,
  };
  markup.forEach(function(ent) {
    switch (ent[0]) {
      case 'SENDER': // user generated messages
        player.name = ent[1].plain.replace(/: $/, ''); // cut “: ” at end
        break;

      case 'PLAYER': // automatically generated messages
        player.name = ent[1].plain;
        player.team = window.teamStringToId(ent[1].team);
        break;

      default:
        break;
    }
  });

  return {
    guid: data[0],
    time: time,
    public: isPublic,
    secure: isSecure,
    alert: msgAlert,
    msgToPlayer: msgToPlayer,
    type: data[2].plext.plextType,
    narrowcast: systemNarrowcast,
    auto: auto,
    team: team,
    player: player,
    markup: markup,
  };
};

/**
 * Writes new chat data to the chat storage and manages the order of messages.
 *
 * @function chat.writeDataToHash
 * @param {Object} newData - The new chat data received.
 * @param {Object} storageHash - The chat storage object.
 * @param {boolean} isOlderMsgs - Whether the new data contains older messages.
 * @param {boolean} isAscendingOrder - Whether the new data is in ascending order.
 */
chat.writeDataToHash = function (newData, storageHash, isOlderMsgs, isAscendingOrder) {
  chat.updateOldNewHash(newData, storageHash, isOlderMsgs, isAscendingOrder);

  newData.result.forEach(function(json) {
    // avoid duplicates
    if (json[0] in storageHash.data) {
      return true;
    }

    var parsedData = chat.parseMsgData(json);

    // format: timestamp, autogenerated, HTML message, nick, additional data (parsed, plugin specific data...)
    storageHash.data[parsedData.guid] = [parsedData.time, parsedData.auto, chat.renderMsgRow(parsedData), parsedData.player.name, parsedData];
    if (isAscendingOrder) {
      storageHash.guids.push(parsedData.guid);
    } else {
      storageHash.guids.unshift(parsedData.guid);
    }
  });
};

//
// Rendering primitive for markup, chat cells (td) and chat row (tr)
//

/**
 * Renders text for the chat, converting plain text to HTML and adding links.
 *
 * @function chat.renderText
 * @param {Object} text - An object containing the plain text to render.
 * @returns {string} The rendered HTML string.
 */
chat.renderText = function (text) {
  let content;

  if (text.team) {
    let teamId = window.teamStringToId(text.team);
    if (teamId === window.TEAM_NONE) teamId = window.TEAM_MAC;
    const spanClass = window.TEAM_TO_CSS[teamId];
    content = $('<div>').append($('<span>', { class: spanClass, text: text.plain }));
  } else {
    content = $('<div>').text(text.plain);
  }

  return content.html().autoLink();
};

/**
 * Overrides portal names used repeatedly in chat, such as 'US Post Office', with more specific names.
 *
 * @function chat.getChatPortalName
 * @param {Object} markup - An object containing portal markup, including the name and address.
 * @returns {string} The processed portal name.
 */
chat.getChatPortalName = function (markup) {
  var name = markup.name;
  if (name === 'US Post Office') {
    var address = markup.address.split(',');
    name = 'USPS: ' + address[0];
  }
  return name;
};

/**
 * Renders a portal link for use in the chat.
 *
 * @function chat.renderPortal
 * @param {Object} portal - The portal data.
 * @returns {string} HTML string of the portal link.
 */
chat.renderPortal = function (portal) {
  var lat = portal.latE6/1E6, lng = portal.lngE6/1E6;
  var perma = window.makePermalink([lat,lng]);
  var js = 'window.selectPortalByLatLng('+lat+', '+lng+');return false';
  return '<a onclick="' + js + '"' + ' title="' + portal.address + '"' + ' href="' + perma + '" class="help">' + chat.getChatPortalName(portal) + '</a>';
};

/**
 * Renders a faction entity for use in the chat.
 *
 * @function chat.renderFactionEnt
 * @param {Object} faction - The faction data.
 * @returns {string} HTML string representing the faction.
 */
chat.renderFactionEnt = function (faction) {
  var teamId = window.teamStringToId(faction.team);
  var name = window.TEAM_NAMES[teamId];
  var spanClass = window.TEAM_TO_CSS[teamId];
  return $('<div>').html($('<span>')
    .attr('class', spanClass)
    .text(name)).html();
};

/**
 * Renders a player's nickname in chat.
 *
 * @function chat.renderPlayer
 * @param {Object} player - The player object containing nickname and team.
 * @param {boolean} at - Whether to prepend '@' to the nickname.
 * @param {boolean} sender - Whether the player is the sender of a message.
 * @returns {string} The HTML string representing the player's nickname in chat.
 */
chat.renderPlayer = function (player, at, sender) {
  var name = player.plain;
  if (sender) {
    name = player.plain.replace(/: $/, '');
  } else if (at) {
    name = player.plain.replace(/^@/, '');
  }
  var thisToPlayer = name === window.PLAYER.nickname;
  var spanClass = 'nickname ' + (thisToPlayer ? 'pl_nudge_me' : (player.team + ' pl_nudge_player'));
  return $('<div>').html($('<span>')
    .attr('class', spanClass)
    .text((at ? '@' : '') + name)).html();
};

/**
 * Renders a chat message entity based on its type.
 *
 * @function chat.renderMarkupEntity
 * @param {Array} ent - The entity array, where the first element is the type and the second element is the data.
 * @returns {string} The HTML string representing the chat message entity.
 */
chat.renderMarkupEntity = function (ent) {
  switch (ent[0]) {
  case 'TEXT':
    return chat.renderText(ent[1]);
  case 'PORTAL':
    return chat.renderPortal(ent[1]);
  case 'FACTION':
    return chat.renderFactionEnt(ent[1]);
  case 'SENDER':
    return chat.renderPlayer(ent[1], false, true);
  case 'PLAYER':
    return chat.renderPlayer(ent[1]);
  case 'AT_PLAYER':
    return chat.renderPlayer(ent[1], true);
  default:
  }
  return $('<div>').text(ent[0]+':<'+ent[1].plain+'>').html();
};

/**
 * Renders the markup of a chat message, converting special entities like player names, portals, etc., into HTML.
 *
 * @function chat.renderMarkup
 * @param {Array} markup - The markup array of a chat message.
 * @returns {string} The HTML string representing the complete rendered chat message.
 */
chat.renderMarkup = function (markup) {
  var msg = '';

  markup.forEach(function (ent, ind) {
    switch (ent[0]) {
      case 'SENDER':
      case 'SECURE':
        // skip as already handled
        break;

      case 'PLAYER': // automatically generated messages
        if (ind > 0) msg += chat.renderMarkupEntity(ent); // don’t repeat nick directly
        break;

      default:
        // add other enitities whatever the type
        msg += chat.renderMarkupEntity(ent);
        break;
    }
  });
  return msg;
};

/**
 * Transforms a given markup array into an older, more straightforward format for easier understanding.
 *
 * @function chat.transformMessage
 * @param {Array} markup - An array representing the markup to be transformed.
 * @returns {Array} The transformed markup array with a simplified structure.
 */
function transformMessage(markup) {
  // Make a copy of the markup array to avoid modifying the original input
  let newMarkup = JSON.parse(JSON.stringify(markup));

  // Collapse <faction> + "Link"/"Field". Example: "Agent <player> destroyed the <faction> Link ..."
  if (newMarkup.length > 4) {
    if (newMarkup[3][0] === 'FACTION' && newMarkup[4][0] === 'TEXT' && (newMarkup[4][1].plain === ' Link ' || newMarkup[4][1].plain === ' Control Field @')) {
      newMarkup[4][1].team = newMarkup[3][1].team;
      newMarkup.splice(3, 1);
    }
  }

  // Skip "Agent <player>" at the beginning
  if (newMarkup.length > 1) {
    if (newMarkup[0][0] === 'TEXT' && newMarkup[0][1].plain === 'Agent ' && newMarkup[1][0] === 'PLAYER') {
      newMarkup.splice(0, 2);
    }
  }

  // Skip "<faction> agent <player>" at the beginning
  if (newMarkup.length > 2) {
    if (newMarkup[0][0] === 'FACTION' && newMarkup[1][0] === 'TEXT' && newMarkup[1][1].plain === ' agent ' && newMarkup[2][0] === 'PLAYER') {
      newMarkup.splice(0, 3);
    }
  }

  return newMarkup;
}

/**
 * Renders a cell in the chat table to display the time a message was sent.
 * Formats the time and adds it to a <time> HTML element with a tooltip showing the full date and time.
 *
 * @function chat.renderTimeCell
 * @param {number} time - The timestamp of the message.
 * @param {string} classNames - Additional class names to be added to the time cell.
 * @returns {string} The HTML string representing a table cell with the formatted time.
 */
chat.renderTimeCell = function (time, classNames) {
  const ta = window.unixTimeToHHmm(time);
  let tb = window.unixTimeToDateTimeString(time, true);
  // add <small> tags around the milliseconds
  tb = (tb.slice(0, 19) + '<small class="milliseconds">' + tb.slice(19) + '</small>').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<td><time class="' + classNames + '" title="' + tb + '" data-timestamp="' + time + '">' + ta + '</time></td>';
};

/**
 * Renders a cell in the chat table for a player's nickname.
 * Wraps the nickname in <mark> HTML element for highlighting.
 *
 * @function chat.renderNickCell
 * @param {string} nick - The nickname of the player.
 * @param {string} classNames - Additional class names to be added to the nickname cell.
 * @returns {string} The HTML string representing a table cell with the player's nickname.
 */
chat.renderNickCell = function (nick, classNames) {
  const i = ['<span class="invisep">&lt;</span>', '<span class="invisep">&gt;</span>'];
  return '<td>' + i[0] + '<mark class="' + classNames + '">' + nick + '</mark>' + i[1] + '</td>';
};

/**
 * Renders a cell in the chat table for a chat message.
 * The message is inserted as inner HTML of the table cell.
 *
 * @function chat.renderMsgCell
 * @param {string} msg - The chat message to be displayed.
 * @param {string} classNames - Additional class names to be added to the message cell.
 * @returns {string} The HTML string representing a table cell with the chat message.
 */
chat.renderMsgCell = function (msg, classNames) {
  return '<td class="' + classNames + '">' + msg + '</td>';
};

/**
 * Renders a row for a chat message including time, nickname, and message cells.
 *
 * @function chat.renderMsgRow
 * @param {Object} data - The data for the message, including time, player, and message content.
 * @returns {string} The HTML string representing a row in the chat table.
 */
chat.renderMsgRow = function (data) {
  var timeClass = data.msgToPlayer ? 'pl_nudge_date' : '';
  var timeCell = chat.renderTimeCell(data.time, timeClass);

  var nickClasses = ['nickname'];
  if (window.TEAM_TO_CSS[data.player.team]) {
    nickClasses.push(window.TEAM_TO_CSS[data.player.team]);
  }
  // highlight things said/done by the player in a unique colour
  // (similar to @player mentions from others in the chat text itself)
  if (data.player.name === window.PLAYER.nickname) {
    nickClasses.push('pl_nudge_me');
  }
  var nickCell = chat.renderNickCell(data.player.name, nickClasses.join(' '));

  const markup = transformMessage(data.markup);
  var msg = chat.renderMarkup(markup);
  var msgClass = data.narrowcast ? 'system_narrowcast' : '';
  var msgCell = chat.renderMsgCell(msg, msgClass);

  var className = '';
  if (!data.auto && data.public) {
    className = 'public';
  } else if (!data.auto && data.secure) {
    className = 'faction';
  }
  return '<tr data-guid="' + data.guid + '" class="' + className + '">' + timeCell + nickCell + msgCell + '</tr>';
};

/**
 * Legacy function for rendering chat messages. Used for backward compatibility with plugins.
 *
 * @function chat.renderMsg
 * @param {string} msg - The chat message.
 * @param {string} nick - The nickname of the player who sent the message.
 * @param {number} time - The timestamp of the message.
 * @param {string} team - The team of the player who sent the message.
 * @param {boolean} msgToPlayer - Flag indicating if the message is directed to the player.
 * @param {boolean} systemNarrowcast - Flag indicating if the message is a system narrowcast.
 * @returns {string} The HTML string representing a chat message row.
 */
chat.renderMsg = function(msg, nick, time, team, msgToPlayer, systemNarrowcast) {
  var ta = window.unixTimeToHHmm(time);
  var tb = window.unixTimeToDateTimeString(time, true);
  // add <small> tags around the milliseconds
  tb = (tb.slice(0,19)+'<small class="milliseconds">'+tb.slice(19)+'</small>')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');

  // help cursor via “#chat time”
  var t = '<time title="'+tb+'" data-timestamp="'+time+'">'+ta+'</time>';
  if (msgToPlayer) {
    t = '<div class="pl_nudge_date">' + t + '</div><div class="pl_nudge_pointy_spacer"></div>';
  }
  if (systemNarrowcast) {
    msg = '<div class="system_narrowcast">' + msg + '</div>';
  }
  var color = COLORS[team];
  // highlight things said/done by the player in a unique colour (similar to @player mentions from others in the chat text itself)
  if (nick === window.PLAYER.nickname) {
    color = '#fd6';
  }
  var s = 'style="cursor:pointer; color:'+color+'"';
  var i = ['<span class="invisep">&lt;</span>', '<span class="invisep">&gt;</span>'];
  return '<tr><td>'+t+'</td><td>'+i[0]+'<mark class="nickname" ' + s + '>'+ nick+'</mark>'+i[1]+'</td><td>'+msg+'</td></tr>';
}

/**
 * Renders a divider row in the chat table.
 *
 * @function chat.renderDivider
 * @param {string} text - Text to display within the divider row.
 * @returns {string} The HTML string representing a divider row in the chat table.
 */
chat.renderDivider = function(text) {
  return '<tr class="divider"><td><hr></td><td>' + text + '</td><td><hr></td></tr>';
};

/**
 * Renders data from the data-hash to the element defined by the given ID.
 *
 * @function chat.renderData
 * @param {Object} data - Chat data to be rendered.
 * @param {string} element - ID of the DOM element to render the chat into.
 * @param {boolean} likelyWereOldMsgs - Flag indicating if older messages are likely to have been added.
 * @param {Array} sortedGuids - Sorted array of GUIDs representing the order of messages.
 */
chat.renderData = function(data, element, likelyWereOldMsgs, sortedGuids) {
  var elm = $('#'+element);
  if (elm.is(':hidden')) {
    return;
  }

  // if sortedGuids is not specified (legacy), sort old to new
  // (disregarding server order)
  var vals = sortedGuids;
  if (vals === undefined) {
    vals = $.map(data, function(v, k) { return [[v[0], k]]; });
    vals = vals.sort(function(a, b) { return a[0]-b[0]; });
    vals = vals.map(function(v) { return v[1]; });
  }

  // render to string with date separators inserted
  var msgs = '';
  var prevTime = null;
  vals.forEach(function(guid) {
    var msg = data[guid];
    var nextTime = new Date(msg[0]).toLocaleDateString();
    if (prevTime && prevTime !== nextTime) {
      msgs += chat.renderDivider(nextTime);
    }
    msgs += msg[2];
    prevTime = nextTime;
  });

  var firstRender = elm.is(':empty');
  var scrollBefore = window.scrollBottom(elm);
  elm.html('<table>' + msgs + '</table>');

  if (firstRender) {
    elm.data('needsScrollTop', 99999999);
  } else {
    chat.keepScrollPosition(elm, scrollBefore, likelyWereOldMsgs);
  }

  if(elm.data('needsScrollTop')) {
    elm.data('ignoreNextScroll', true);
    elm.scrollTop(elm.data('needsScrollTop'));
    elm.data('needsScrollTop', null);
  }
};

//
// Posting
//

/**
 * Posts a chat message to intel comm context.
 *
 * @function chat.sendChatMessage
 * @param {string} tab intel tab name (either all or faction)
 * @param {string} msg message to be sent
 */
chat.sendChatMessage = function (tab, msg) {
  if (tab !== 'all' && tab !== 'faction') return;

  var latlng = map.getCenter();

  var data = {message: msg,
              latE6: Math.round(latlng.lat*1E6),
              lngE6: Math.round(latlng.lng*1E6),
              tab: tab};

  var errMsg = 'Your message could not be delivered. You can copy&' +
               'paste it here and try again if you want:\n\n' + msg;

  window.postAjax('sendPlext', data,
    function(response) {
      if(response.error) alert(errMsg);
      window.startRefreshTimeout(0.1*1000); //only chat uses the refresh timer stuff, so a perfect way of forcing an early refresh after a send message
    },
    function() {
      alert(errMsg);
    }
  );
};

//
// Channels
//

// WORK IN PROGRESS
// 'all' 'faction' and 'alerts' channels are hard coded in several places (including mobile app)
// dont change those channels since they refer to stock channels
// you can add channels from another source provider (message relay, logging from plugins...)
chat.channels = [
  // id: uniq id, matches 'tab' parameter for server requests
  // name: visible name
  // inputPrompt: (optional) string for the input prompt
  // inputClass: (optional) class to apply to #chatinput
  // sendMessage(id, msg): (optional) function to send the message
  //              first argument is `id`
  // request(id, getOlderMsgs, isRetry): (optional) function to call
  //          to request new message, first argument is `id`, second is true
  //          when trigger from scrolling to top
  // render(id, oldMsgsWereAdded): (optional) function to render channel content
  // localBounds: (optional) if true, reset on view change
  {
    id: 'all', name: 'All', localBounds: true,
    inputPrompt: 'broadcast:', inputClass: 'public',
    request: chat.requestChannel, render: chat.renderChannel,
    sendMessage: chat.sendChatMessage,
  },
  {
    id: 'faction', name: 'Faction', localBounds: true,
    inputPrompt: 'tell faction:', inputClass:'faction',
    request: chat.requestChannel, render: chat.renderChannel,
    sendMessage: chat.sendChatMessage,
  },
  {
    id: 'alerts', name: 'Alerts',
    inputPrompt: 'tell Jarvis:', inputClass: 'alerts',
    request: chat.requestChannel, render: chat.renderChannel,
    sendMessage: function() {
      alert("Jarvis: A strange game. The only winning move is not to play. How about a nice game of chess?\n(You can't chat to the 'alerts' channel!)");
    }
  },
];

/**
 * Holds data related to each channel.
 *
 * @memberof window.chat
 * @type {Object}
 */
chat._channels = {};

/**
 * Initialize the channel data.
 *
 * @function chat.initChannelData
 * @returns {string} The channel object.
 */
chat.initChannelData = function (channel) {
  // preserve channel object
  if (!chat._channels[channel.id]) chat._channels[channel.id] = {};
  chat._channels[channel.id].data = {};
  chat._channels[channel.id].guids = [];
  chat._channels[channel.id].oldestTimestamp = -1;
  delete chat._channels[channel.id].oldestGUID;
  chat._channels[channel.id].newestTimestamp = -1;
  delete chat._channels[channel.id].newestGUID;
};

/**
 * Gets the name of the active chat tab.
 *
 * @function chat.getActive
 * @returns {string} The name of the active chat tab.
 */
chat.getActive = function() {
  return $('#chatcontrols .active').data('channel');
}

/**
 * Converts a chat tab name to its corresponding channel object.
 *
 * @function chat.getChannelDesc
 * @param {string} tab - The name of the chat tab.
 * @returns {string} The corresponding channel name ('faction', 'alerts', or 'all').
 */
chat.getChannelDesc = function (tab) {
  var channelObject = null;
  chat.channels.forEach(function (entry) {
    if (entry.id === tab)
      channelObject = entry;
  });
  return channelObject;
};

/**
 * Toggles the chat window between expanded and collapsed states.
 * When expanded, the chat window covers a larger area of the screen.
 * This function also ensures that the chat is scrolled to the bottom when collapsed.
 *
 * @function chat.toggle
 */
chat.toggle = function() {
  var c = $('#chat, #chatcontrols');
  if(c.hasClass('expand')) {
    c.removeClass('expand');
    var div = $('#chat > div:visible');
    div.data('ignoreNextScroll', true);
    div.scrollTop(99999999); // scroll to bottom
    $('.leaflet-control').removeClass('chat-expand');
  } else {
    c.addClass('expand');
    $('.leaflet-control').addClass('chat-expand');
    chat.needMoreMessages();
  }
};

/**
 * Allows plugins to request and monitor COMM data streams in the background. This is useful for plugins
 * that need to process COMM data even when the user is not actively viewing the COMM channels.
 * It tracks the requested channels for each plugin instance and updates the global state accordingly.
 *
 * @function chat.backgroundChannelData
 * @param {string} instance - A unique identifier for the plugin or instance requesting background COMM data.
 * @param {string} channel - The name of the COMM channel ('all', 'faction', or 'alerts').
 * @param {boolean} flag - Set to true to request data for the specified channel, false to stop requesting.
 */
chat.backgroundChannelData = function(instance,channel,flag) {
  //first, store the state for this instance
  if (!chat.backgroundInstanceChannel) chat.backgroundInstanceChannel = {};
  if (!chat.backgroundInstanceChannel[instance]) chat.backgroundInstanceChannel[instance] = {};
  chat.backgroundInstanceChannel[instance][channel] = flag;

  //now, to simplify the request code, merge the flags for all instances into one
  // 1. clear existing overall flags
  chat.backgroundChannels = {};
  // 2. for each instance monitoring COMM...
  $.each(chat.backgroundInstanceChannel, function(instance,channels) {
    // 3. and for each channel monitored by this instance...
    $.each(chat.backgroundInstanceChannel[instance],function(channel,flag) {
      // 4. if it's monitored, set the channel flag
      if (flag) chat.backgroundChannels[channel] = true;
    });
  });

}

/**
 * Requests chat messages for the currently active chat tab and background channels.
 * It calls the appropriate request function based on the active tab or background channels.
 *
 * @function chat.request
 */
chat.request = function() {
  var channel = chat.getActive();
  chat.channels.forEach(function (entry) {
    if (channel === entry.id || (chat.backgroundChannels && chat.backgroundChannels[entry.id])) {
      if (entry.request)
        entry.request(entry.id, false);
    }
  });
}

/**
 * Checks if the currently selected chat tab needs more messages.
 * This function is triggered by scroll events and loads older messages when the user scrolls to the top.
 *
 * @function chat.needMoreMessages
 */
chat.needMoreMessages = function() {
  var activeTab = chat.getActive();
  var channel = chat.getChannelDesc(activeTab);
  if(!channel || !channel.request) return;

  var activeChat = $('#chat > :visible');
  if(activeChat.length === 0) return;

  var hasScrollbar = window.scrollBottom(activeChat) !== 0 || activeChat.scrollTop() !== 0;
  var nearTop = activeChat.scrollTop() <= CHAT_REQUEST_SCROLL_TOP;
  if(hasScrollbar && !nearTop) return;

  channel.request(channel.id, false);
};

/**
 * Chooses and activates a specified chat tab.
 * Also triggers an early refresh of the chat data when switching tabs.
 *
 * @function chat.chooseTab
 * @param {string} tab - The name of the chat tab to activate ('all', 'faction', or 'alerts').
 */
chat.chooseTab = function(tab) {
  if (chat.channels.every(function (entry) { return entry.id !== tab; })) {
    var tabsAvalaible = chat.channels.map(function (entry) { return '"' + entry.id + '"'; }).join(', ');
    log.warn('chat tab "' + tab + '" requested - but only ' + tabsAvalaible + ' are valid - assuming "all" wanted');
    tab = 'all';
  }

  var oldTab = chat.getActive();

  localStorage['iitc-chat-tab'] = tab;

  var oldChannel = chat.getChannelDesc(oldTab);
  var channel = chat.getChannelDesc(tab);

  var chatInput = $('#chatinput');
  if (oldChannel && oldChannel.inputClass) chatInput.removeClass(oldChannel.inputClass);
  if (channel.inputClass) chatInput.addClass(channel.inputClass);

  var mark = $('#chatinput mark');
  mark.text(channel.inputPrompt || '');

  $('#chatcontrols .active').removeClass('active');
  $("#chatcontrols a[data-channel='" + tab + "']").addClass('active');

  if (tab != oldTab) window.startRefreshTimeout(0.1*1000); //only chat uses the refresh timer stuff, so a perfect way of forcing an early refresh after a tab change

  $('#chat > div').hide();

  var elm = $('#chat' + tab);
  elm.show();

  if (channel.render) channel.render(tab);

  if(elm.data('needsScrollTop')) {
    elm.data('ignoreNextScroll', true);
    elm.scrollTop(elm.data('needsScrollTop'));
    elm.data('needsScrollTop', null);
  }
}

/**
 * Displays the chat interface and activates a specified chat tab.
 *
 * @function chat.show
 * @param {string} name - The name of the chat tab to show and activate.
 */
chat.show = function(name) {
    window.isSmartphone()
        ? $('#updatestatus').hide()
        : $('#updatestatus').show();
    $('#chat, #chatinput').show();

    chat.chooseTab(name);
}

/**
 * Chat tab chooser handler.
 * This function is triggered by a click event on the chat tab. It reads the tab name from the event target
 * and activates the corresponding chat tab.
 *
 * @function chat.chooser
 * @param {Event} event - The event triggered by clicking a chat tab.
 */
chat.chooser = function(event) {
  var t = $(event.target);
  var tab = t.data('channel');
  chat.chooseTab(tab);
}

/**
 * Maintains the scroll position of a chat box when new messages are added.
 * This function is designed to keep the scroll position fixed when old messages are loaded, and to automatically scroll
 * to the bottom when new messages are added if the user is already at the bottom of the chat.
 *
 * @function chat.keepScrollPosition
 * @param {jQuery} box - The jQuery object of the chat box.
 * @param {number} scrollBefore - The scroll position before new messages were added.
 * @param {boolean} isOldMsgs - Indicates if the added messages are older messages.
 */
chat.keepScrollPosition = function(box, scrollBefore, isOldMsgs) {
  // If scrolled down completely, keep it that way so new messages can
  // be seen easily. If scrolled up, only need to fix scroll position
  // when old messages are added. New messages added at the bottom don’t
  // change the view and enabling this would make the chat scroll down
  // for every added message, even if the user wants to read old stuff.

  if(box.is(':hidden') && !isOldMsgs) {
    box.data('needsScrollTop', 99999999);
    return;
  }

  if(scrollBefore === 0 || isOldMsgs) {
    box.data('ignoreNextScroll', true);
    box.scrollTop(box.scrollTop() + (window.scrollBottom(box)-scrollBefore));
  }
}

//
// comm tab api
//

function createChannelTab (channelDesc) {
  var chatControls = $('#chatcontrols');
  var chatDiv = $('#chat');
  var accessLink = L.Util.template(
    '<a data-channel="{id}" accesskey="{index}" title="[{index}]">{name}</a>',
    channelDesc
  );
  $(accessLink).appendTo(chatControls).click(chat.chooser);

  var channelDiv = L.Util.template(
    '<div id="chat{id}"><table></table></div>',
    channelDesc
  );
  var elm = $(channelDiv).appendTo(chatDiv);
  if (channelDesc.request) {
    elm.scroll(function() {
      var t = $(this);
      if(t.data('ignoreNextScroll')) return t.data('ignoreNextScroll', false);
      if(t.scrollTop() < CHAT_REQUEST_SCROLL_TOP)
        channelDesc.request(channelDesc.id, true);
      if(window.scrollBottom(t) === 0)
        channelDesc.request(channelDesc.id, false);
    });
  }

  // pane
  if (window.useAndroidPanes()) {
    // exlude hard coded panes
    if (channelDesc.id !== 'all' && channelDesc.id !== 'faction' && channelDesc.id !== 'alerts') {
      android.addPane(channelDesc.id, channelDesc.name, 'ic_action_view_as_list');
    }
  }
}

var isTabsSetup = false;
chat.addChannel = function (channelDesc) {
  // deny reserved name
  if (channelDesc.id == 'info' || channelDesc.id == 'map') {
    log.warn('could not add channel "' + channelDesc.id + '": reserved');
    return false;
  }
  if (chat.getChannelDesc(channelDesc.id)) {
    log.warn('could not add channel "' + channelDesc.id + '": already exist');
    return false;
  }

  chat.channels.push(channelDesc);
  channelDesc.index = chat.channels.length;

  if (isTabsSetup) createChannelTab(channelDesc);

  return true;
};


//
// setup
//

chat.setupTabs = function () {
  isTabsSetup = true;
  chat.channels.forEach(function (entry, i) {
    entry.index = i+1;
    chat.initChannelData(entry);
    createChannelTab(entry);
  });
  // legacy compatibility
  chat._public = chat._channels.all;
  chat._faction = chat._channels.faction;
  chat._alerts = chat._channels.alerts;
};

/**
 * Sets up the chat interface.
 *
 * @function chat.setup
 */
chat.setup = function() {
  chat.setupTabs();

  if (localStorage['iitc-chat-tab']) {
    chat.chooseTab(localStorage['iitc-chat-tab']);
 }

  $('#chatcontrols, #chat, #chatinput').show();

  $('#chatcontrols a:first').click(chat.toggle);


  $('#chatinput').click(function() {
    $('#chatinput input').focus();
  });

  chat.setupTime();
  chat.setupPosting();

  window.requests.addRefreshFunction(chat.request);

  var cls = PLAYER.team === 'RESISTANCE' ? 'res' : 'enl';
  $('#chatinput mark').addClass(cls);

  $(document).on('click', '.nickname', function(event) {
    return chat.nicknameClicked(event, $(this).text());
  });
}

/**
 * Sets up the time display in the chat input box.
 * This function updates the time displayed next to the chat input field every minute to reflect the current time.
 *
 * @function chat.setupTime
 */
chat.setupTime = function() {
  var inputTime = $('#chatinput time');
  var updateTime = function() {
    if(window.isIdle()) return;
    var d = new Date();
    var h = d.getHours() + ''; if(h.length === 1) h = '0' + h;
    var m = d.getMinutes() + ''; if(m.length === 1) m = '0' + m;
    inputTime.text(h+':'+m);
    // update ON the minute (1ms after)
    setTimeout(updateTime, (60 - d.getSeconds()) * 1000 + 1);
  };
  updateTime();
  window.addResumeFunction(updateTime);
}


//
// posting
//


/**
 * Sets up the chat message posting functionality.
 *
 * @function chat.setupPosting
 */
chat.setupPosting = function() {
  if (!window.isSmartphone()) {
    $('#chatinput input').keydown(function(event) {
      try {
        var kc = (event.keyCode ? event.keyCode : event.which);
        if(kc === 13) { // enter
          chat.postMsg();
          event.preventDefault();
        } else if (kc === 9) { // tab
          event.preventDefault();
          chat.handleTabCompletion();
        }
      } catch (e) {
        log.error(e);
        //if (e.stack) { console.error(e.stack); }
      }
    });
  }

  $('#chatinput').submit(function(event) {
    event.preventDefault();
    chat.postMsg();
  });
};

/**
 * Posts a chat message to the currently active chat tab.
 *
 * @function chat.postMsg
 */
chat.postMsg = function() {
  var c = chat.getActive();
  var channel = chat.getChannelDesc(c);

  var msg = $.trim($('#chatinput input').val());
  if(!msg || msg === '') return;

  if (channel.sendMessage) {
    channel.sendMessage(msg);
    $('#chatinput input').val('');
  }
};
