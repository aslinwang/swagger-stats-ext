/**
 * Created by sv2 on 2/16/17.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');
const debug = require('debug')('sws:interface');
const promClient = require("prom-client");
const basicAuth = require("basic-auth");
const Cookies = require('cookies');
const uuidv1 = require('uuid/v1');
const e2k = require('express-to-koa')

const swsSettings = require('./swssettings');
const swsUtil = require('./swsUtil');
const swsProcessor = require('./swsProcessor');
const swsEgress = require('./swsegress');
const send = require('send');
const qs = require('qs');

const swsHapi = require('./swsHapi');
const pm2MiddleWare = require('./pm2')

// API data processor
//var processor = null;

var uiMarkup = swsUtil.swsEmbeddedUIMarkup;

// Session IDs storage
var sessionIDs = {};

const SESSIONIDS_KEY = 'sessionIDs'

function isLogin(sid) {
    return new Promise((resolve, reject) => {
        if (swsSettings.redis) {
            swsSettings.redis.hget(SESSIONIDS_KEY, sid, (err, value) => {
                if (err) {
                    debug("SWS:isLogin:ERROR: " + err);
                    reject(err);
                }
                resolve(!!value)
            })
        }
        else {
            resolve(sid in sessionIDs)
        }
    })
}

// Store / update session id
async function storeSessionID(sid){
    var tssec = Date.now() + swsSettings.sessionMaxAge*1000;

    return new Promise((resolve, reject) => {
        if (swsSettings.redis) {
            swsSettings.redis.hset(SESSIONIDS_KEY, sid, tssec, (err) => {
                if (err) {
                    debug("SWS:storeSessionID:ERROR: " + err);
                    reject(err);
                }
                swsSettings.redis.expire(SESSIONIDS_KEY, swsSettings.sessionMaxAge);
                resolve();
            })
        }
        else {
            sessionIDs[sid] = tssec;
            resolve();
        }
    })
    //debug('Session ID updated: %s=%d', sid,tssec);
}

// Remove Session ID
function removeSessionID(sid){
    return new Promise((resolve, reject) => {
        if (swsSettings.redis) {
            swsSettings.redis.hdel(SESSIONIDS_KEY, sid, (err) => {
                if (err) {
                    debug("SWS:removeSessionID:ERROR: " + err);
                    reject(err);
                }
                resolve();
            })
        }
        else {
            delete sessionIDs[sid];
            resolve();
        }
    })
}

// If authentication is enabled, executed periodically and expires old session IDs
function expireSessionIDs(){
    if (swsSettings.redis) {
        return;
    }
    var tssec = Date.now();
    var expired = [];
    for(var sid in sessionIDs){
        if(sessionIDs[sid] < (tssec + 500)){
            expired.push(sid);
        }
    }
    for(var i=0;i<expired.length;i++){
        delete sessionIDs[expired[i]];
        debug('Session ID expired: %s', expired[i]);
    }
}

// Request hanlder
function handleRequest(req, res){
    try {
        swsProcessor.processRequest(req,res);
    }catch(e){
        debug("SWS:processRequest:ERROR: " + e);
        return;
    }

    if(('sws' in req) && ('track' in req.sws) && !req.sws.track ){
        // Tracking disabled for this request
        return;
    }

    // Setup handler for finishing reponse
    res.on('finish',function(){
        handleResponseFinished(this);
    });
}

// Response finish hanlder
function handleResponseFinished(res){
    try {
        swsProcessor.processResponse(res);
    }catch(e){
        debug("SWS:processResponse:ERROR: " + e);
    }
}

function processAuth(req,res,useWWWAuth) {

    return new Promise( async (resolve, reject) => {
        if( !swsSettings.authentication ){
            return resolve(true);
        }

        var cookies = new Cookies( req, res );

        // Check session cookie
        var sessionIdCookie = cookies.get('sws-session-id');
        if( (sessionIdCookie !== undefined) && (sessionIdCookie !== null) ){

            if (await isLogin(sessionIdCookie)) {
                // renew it
                //sessionIDs[sessionIdCookie] = Date.now();
                await storeSessionID(sessionIdCookie);
                cookies.set('sws-session-id',sessionIdCookie,{path:swsSettings.uriPath,maxAge:swsSettings.sessionMaxAge*1000});
                // Ok
                req['sws-auth'] = true;
                return resolve(true);
            }
        }

        var authInfo = basicAuth(req);

        var authenticated = false;
        var msg = 'Authentication required';

        if( (authInfo !== undefined) && (authInfo!==null) && ('name' in authInfo) && ('pass' in authInfo)){
            if(typeof swsSettings.onAuthenticate === 'function'){

                Promise.resolve(swsSettings.onAuthenticate(req, authInfo.name, authInfo.pass)).then(async function(onAuthResult) {
                    if( onAuthResult ){

                        authenticated = true;

                        // Session is only for stats requests
                        if(req.url.startsWith(swsSettings.pathStats)){
                            // Generate session id
                            var sessid = uuidv1();
                            await storeSessionID(sessid);
                            // Set session cookie with expiration in 15 min
                            cookies.set('sws-session-id',sessid,{path:swsSettings.uriPath,maxAge:swsSettings.sessionMaxAge*1000});
                        }

                        req['sws-auth'] = true;
                        return resolve(true);

                    }else{
                        msg = 'Invalid credentials';
                        res.statusCode = 403;
                        res.end(msg);
                        return resolve(false);
                    }
                });

            }else{
                res.statusCode = 403;
                res.end(msg);
                return resolve(false);
            }
        }else{
            res.statusCode = 403;
            res.end(msg);
            return resolve(false);
        }

    });

}

async function processLogout(req,res){

    var cookies = new Cookies( req, res );

    // Check session cookie
    var sessionIdCookie = cookies.get('sws-session-id');
    if( (sessionIdCookie !== undefined) && (sessionIdCookie !== null) ){
        if (await isLogin(sessionIdCookie)) {
            await removeSessionID(sessionIdCookie);
            cookies.set('sws-session-id'); // deletes cookie
        }
    }

    res.statusCode = 200;
    res.end('Logged out');
}


// Process /swagger-stats/stats request
// Return statistics according to request parameters
// Query parameters (fields, path, method) defines which stat fields to return
function processGetStats(req,res){

    processAuth(req,res).then(function (authResult){
        if(!authResult){
            return;
        }
        res.statusCode = 200;
        if(('sws-auth' in req) && req['sws-auth']){
            res.setHeader('x-sws-authenticated','true');
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(swsProcessor.getStats(req.sws.query)));
    });
}


// Process /swagger-stats/metrics request
// Return all metrics for Prometheus
function processGetMetrics(req,res){

    processAuth(req,res).then(function (authResult){
        if(!authResult){
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end(promClient.register.metrics());
    });
}

// Express Middleware
function expressMiddleware(options) {

    if (options) {
        // Init settings
        swsSettings.init(options);

        // Init probes
        swsEgress.init();

        if( swsSettings.authentication ){
            setInterval(expireSessionIDs,500);
        }

        swsProcessor.init();
    }

    return async function trackingMiddleware(req, res, next) {
        res._swsReq = req;
        req.sws = {};
        req.sws.query = qs.parse(url.parse(req.url).query);

        // Respond to requests handled by swagger-stats
        // swagger-stats requests will not be counted in statistics
        if(req.url.startsWith(swsSettings.pathStats)) {
            return processGetStats(req, res);
        }else if(req.url.startsWith(swsSettings.pathMetrics)){
            return processGetMetrics(req,res);
        }else if(req.url.startsWith(swsSettings.pathLogout)){
            await processLogout(req,res);
            return;
        }else if(req.url.startsWith(swsSettings.pathUI) ){
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html');
            res.end(uiMarkup);
            return;
        }else if(req.url.startsWith(swsSettings.pathDist)) {
            var fileName = req.url.replace(swsSettings.pathDist+'/','');
            var qidx = fileName.indexOf('?');
            if(qidx!=-1) fileName = fileName.substring(0,qidx);

            var options = {
                root: path.join(__dirname,'..','dist'),
                dotfiles: 'deny'
                // TODO Caching
            };
            res.setHeader('Content-Type', send.mime.lookup(path.basename(fileName)));
            send(req, fileName, options).pipe(res);
            return;
        }else if (swsSettings.pathProm && req.url.startsWith(swsSettings.pathProm)) {
            res.end(await getPromMetrics());
            return;
        }

        handleRequest(req, res);

        return next();
    };
}

function koaMiddleware(options) {
    return e2k(expressMiddleware(options))
}

function fastifyPlugin (fastify, opts, done) {
    fastify.decorate('utility', () => {})
    fastify.use(expressMiddleware(opts));
    /*
    fastify.addHook('onRequest', (request, reply, done) => {
        const self = this;
        console.log(`Got onRequest`);
        done()
    });
     */
    fastify.addHook('onResponse', (request, reply, done) => {
        // pre-process request, response, context before response handled by sws
        // Capture Fastify-specific data
        request.raw.sws = request.raw.sws || {};
        // TODO Headers
        //let h = Object.getOwnPropertySymbols(reply);
        //let hh = reply[headersSymbol];
        // Set route_path as reply.context.config.url
        if(('context' in reply) && ('config' in reply.context) && ('url' in reply.context.config)){
            request.raw.sws.route_path = reply.context.config.url;
        }
        done()
    });
    done();
}
fastifyPlugin[Symbol.for('skip-override')] = true;

function getPromStats() {
    return promClient.register.metrics();
}

async function getPromMetrics() {
    if (swsSettings.pm2) {
        return pm2MiddleWare.getPm2Metrics({
            promClient,
            getPromStats
        })
    }
    else {
        return getPromStats()
    }
}

module.exports = {

    // Returns Hapi plugin
    getHapiPlugin: {
        name: 'swagger-stats',
        version: '0.97.9',
        register: async function (server, options) {

            // Init settings
            swsSettings.init(options);

            // Init probes TODO Reconsider
            swsEgress.init();

            swsProcessor.init();

            return swsHapi.register(server, options);
        }
    },

    getFastifyPlugin: fastifyPlugin,

    // Initialize swagger-stats and return
    // middleware to perform API Data collection
    getMiddleware: expressMiddleware,

    koaMiddleware,

    // TODO Support specifying which stat fields to return
    // Returns object with collected statistics
    getCoreStats: function() {
        return swsProcessor.getStats();
    },

    // Allow get stats as prometheus format
    getPromStats,

    // Expose promClient to allow for custom metrics by application
    getPromClient: function () {
        return promClient;
    },

    // Stop the processor so that Node.js can exit
    stop: function () {
        return swsProcessor.stop();
    },

    init: function (options) {
        // Init settings
        swsSettings.init(options);

        // Init probes
        swsEgress.init();

        if( swsSettings.authentication ){
            setInterval(expireSessionIDs,500);
        }

        swsProcessor.init();
    },

    getPromMetrics,

    // report mcall based on http protocol manually
    // mcall_request_total counter
    reportMCall: function (service, method, path, http_code, code) {
        code = code || '0'
        if (!!service && !! method && !!path && !!http_code && !!code) {
            method = method.toString().toUpperCase()
            swsProcessor.apiStats.promClientMetrics.mcall_request_total.labels(service, method, path, http_code, code).inc()
        }
    }
};
