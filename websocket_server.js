var http = require('http');
var WebSocketServer = require('websocket').server;
var url = require('url')
var path = require('path')

var fs = require('fs');

const PUBLISHER_RULE = "pub"
const SUBSCRIBER_RULE = "sub"
const BROWSER_RULE = "browser"
const VERBOSE = true

/**
 * When the streamer sets this field, it will be compliant with this format:
 *	{
  		fps: 20,				//frame rate
  		encodeBps: 500000,		//encoder bitrate (default=500Kpbs)
  		width: 320,				//frame width
  		height: 240,			//frame height
  		configArray: '',		//SPS-PPS array for H.264 stream configuration
  	}
 */
var configuration = undefined;
var port = 8080;
var streamer = undefined
var publisherDeviceName = undefined
var subscribers = [];
var browserClients = [];
var qualities = [];
var currentQuality = undefined;
var bitrates = [];
var currentBitrate = undefined;

var httpServerCallback = function(request, response) {

  var uri = url.parse(request.url).pathname
    , filename = path.join(process.cwd(), uri);

  fs.stat(filename, function(err, stat) {
    if(err) {
			console.log("err="+err.code)
      response.writeHead(404, {"Content-Type": "text/plain"});
      response.write("404 Not Found\n");
      response.end();
      return;
    }
    if (stat.isDirectory()){
			filename += '/index.html';
		}
    fs.readFile(filename, "binary", function(err, file) {
      if(err) {
        response.writeHead(500, {"Content-Type": "text/plain"});
        response.write(err + "\n");
        response.end();
        return;
      }
      response.writeHead(200);
      response.write(file, "binary");
      response.end();
    });
  });
}

var server = http.createServer(httpServerCallback);
server.listen(port, function() {
	console.log((new Date()) + ' Server running at http://127.0.0.1:'+port);
});


var onTextMessageReceived = function(message, webSocket) {
	var json;
	if ((json = parseJSON(message.utf8Data)) != null){
		if (!json.hasOwnProperty('rule')){
			console.log("No rule for this JSON message. Will discard...");
			return;
		}
		//I'm the sender
		if (json.rule === PUBLISHER_RULE){
			switch (json.type) {
        case 'hello':
          streamer = webSocket
          publisherDeviceName = json.device
          currentQuality = json.current
          qualities = []
          json.qualities.forEach(function(element, index, array){
                  var q = element.split("x");
                    if (q.length != 2){
                      return;
                  }
                    var newQuality = {
                        width: parseInt(q[0]),
                        height: parseInt(q[1])
                    }
                    qualities.push(newQuality)
                })
          bitrates = json.bitrates;
          currentBitrate = json.currentBitrate;
          if (VERBOSE) {
              console.log("Hello from publisher '"+json.device+"'\n My resolutions: "+json.qualities);
              logAll()
          }
          var qualitiesNotice = getQualitiesNoticePacket();
          forwardToBrowsers(JSON.stringify(qualitiesNotice));
          //forwardToSubscribers(JSON.stringify(qualitiesNotice));
          break;

				case 'config':
					var configArray = json.data;
					var width = json.width;
					var height = json.height;
					var encodeBps = json.encodeBps;
					var frameRate = json.frameRate;
          currentQuality = width + "x" + height;
					currentBitrate = encodeBps;
          if (VERBOSE) console.log("\nNew quality: "+currentQuality);

          var qualitiesNotice = getQualitiesNoticePacket();
          forwardToBrowsers(JSON.stringify(qualitiesNotice));

					setConfigParams(configArray, width, height, encodeBps, frameRate);
					var response = getConfigPacket();
					if (VERBOSE) console.log("sending config: "+JSON.stringify(response)+" to subscribers ");
					forwardToSubscribers(JSON.stringify(response));
					break;

				case 'stream':
					var response = message.utf8Data;
          if (VERBOSE) process.stdout.write('.');
					//if (VERBOSE) process.stdout.write('['+json.data.length+'] ')
					forwardToSubscribers(response);
					break;

				case 'reset':
					break;
			}

		}

		//I'm the receiver
		else if (json.rule === SUBSCRIBER_RULE){
            switch (json.type) {
                case 'hello':
                    if (subscribers.indexOf(webSocket) < 0){
                        subscribers.push(webSocket);
                        if (VERBOSE){
                            console.log("Hello from subscriber: "+webSocket.remoteAddress)
                            logAll()
                        }
                    }
                    break;

                case 'config':
                    if (VERBOSE) console.log("config requested by sub "+webSocket.remoteAddress)
                    var conf = getConfigPacket()
					if (conf === undefined){
						//no configuration was set, i.e. no stream sender started streaming
						if (VERBOSE) console.log("no config available yet")
						break;
					}
					//send configuration back to the client who made request
					if (VERBOSE) console.log("sending config params to sub "+webSocket.remoteAddress)
                    webSocket.sendUTF(JSON.stringify(conf))
                    break;
            }
		}

        //I'm the browser client
        else if (json.rule === BROWSER_RULE){
            switch (json.type) {
                case 'hello':
                    if (browserClients.indexOf(webSocket) < 0){
                        browserClients.push(webSocket);
                        if (VERBOSE) {
                            console.log("Hello from browser client: "+webSocket.remoteAddress)
                            logAll()
                        }
                    }
                    //must contain qualities, if they exist
                    var qualitiesNotice = getQualitiesNoticePacket();
                    webSocket.sendUTF(JSON.stringify(qualitiesNotice));
                    break;

                case 'reset':
                    if (VERBOSE) console.log("Received RESET from client "+webSocket.remoteAddress)
                    logAll()
                    var response = message.utf8Data;
                    forwardToStreamer(response);
                    forwardToSubscribers(response);
                    //webSocket.sendUTF(response)
                    break;
            }
        }

	}
}


wsServer = new WebSocketServer({
    httpServer: server,
    autoAcceptConnections: false
});

wsServer.on('request', function(request) {
	//console.log("REQ from "+request.origin);
	wsServer.config.maxReceivedMessageSize = 16*1024*1024
	wsServer.config.maxReceivedFrameSize = 512*1024
    var connection = request.accept(null,request.origin);
    console.log((new Date()) + ' Connection accepted.')
    connection.on('message', function(message){
    	if (message.type === 'utf8') {
    		onTextMessageReceived(message, connection);
    	}
    	else if (message.type === 'binary') {
			/*console.log('Received' + message.binaryData.length + 'bytes');
			*/
		}
    });
    connection.on('close', function(reasonCode, description) {
        if (connection === streamer){
            streamer = undefined;
            publisherDeviceName = undefined;
            qualities = [];
            currentQuality = undefined;
            bitrates = [];
            currentBitrate = undefined;
			configuration = undefined;
            if (VERBOSE) {
				console.log("\nStreamer reset! Bye");
				logAll();
			}
        }
        if (subscribers.indexOf(connection) >= 0){
            if (VERBOSE) console.log("Subscriber "+connection.remoteAddress+" left");
            subscribers.splice(subscribers.indexOf(connection), 1);
        }
        if (browserClients.indexOf(connection) >= 0){
            if (VERBOSE) console.log("Browser client "+connection.remoteAddress+" left");
            browserClients.splice(browserClients.indexOf(connection), 1);
        }
		console.log((new Date()) + ' client ' + connection.remoteAddress + ' disconnected.');
	});
});

function forwardToStreamer(obj){
	if (streamer !== undefined){
		streamer.sendUTF(obj);
	}
}

function forwardToSubscribers(obj){
    for (var i=0; i < subscribers.length; i++) {
        subscribers[i].sendUTF(obj);
    }
}

function forwardToBrowsers(obj){
    for (var i=0; i < browserClients.length; i++) {
        browserClients[i].sendUTF(obj);
    }
}

function setConfigParams(configArray, width, height, encodeBps, frameRate){
	configuration = {
		fps: frameRate,
		encodeBps: encodeBps,
		width: width,
		height: height,
		configArray: configArray
	};
}

function getConfigPacket(){
	if (configuration === undefined){
		return undefined;
	}
	var obj = {
		type: 'config',
		fps: configuration.fps,
		configArray: configuration.configArray,
		encodeBps: configuration.encodeBps,
		width: configuration.width,
		height: configuration.height
	}
	return obj;
}

function getQualitiesNoticePacket(){
    var obj = {
        sizes: qualities,
        currentSize: currentQuality,
        bitrates: bitrates,
        currentBitrate: currentBitrate
    }
    return obj;
}

//utility functions
function parseJSON(str){
	var obj;
	try{
		obj = JSON.parse(str);
	}
	catch(e){
		console.log('syntax error: '+str);
		return null;
	}
	return obj;
}


function originIsAllowed(origin) {
  // put logic here to detect whether the specified origin is allowed.
  return true;
}

function logAll(){
	console.log('publisher: ' + ((streamer === undefined) ? streamer : streamer.remoteAddress))
	var s = '[ '
	for (var i=0; i < subscribers.length; i++) {
		s += subscribers[i].remoteAddress + ' '
    }
    s += ']'
    console.log("subscribers: "+s)
    s = '[ '
	for (var i=0; i < browserClients.length; i++) {
		s += browserClients[i].remoteAddress + ' '
    }
    s += ']'
    console.log("browser clients: "+s)
	console.log("configuration= "+JSON.stringify(configuration))
}
