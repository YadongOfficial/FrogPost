/**
 * FrogPost Extension
 * Originally Created by thisis0xczar/Lidor JFrog AppSec Team
 * Refined on: 2025-04-27
 */
const log = { debug: (...args) => console.debug("BG:", ...args), info: (...args) => console.info("BG:", ...args), warn: (...args) => console.warn("BG:", ...args), error: (...args) => console.error("BG:", ...args), handler: (...args) => console.log("BG HANDLER:", ...args), scan: (...args) => console.log("BG SCAN:", ...args), };
let frameConnections = new Map();
let messageBuffer;
const injectedFramesAgents = new Map();
const HANDLER_ENDPOINT_KEYS_STORAGE_KEY = 'handler_endpoint_keys';
let endpointsWithDetectedHandlers = new Set();
let nativePort = null;
const NATIVE_HOST_NAME = "com.nodeserver.starter";
let consoleSuccessIndices = [];
let activeDebugSessions = new Map();

class CircularMessageBuffer {
    constructor(maxSize = 1000) { this.maxSize = maxSize; this.buffer = new Array(this.maxSize); this.head = 0; this.size = 0; }
    push(message) { message.messageId = message.messageId || `${message.timestamp || Date.now()}-${Math.random().toString(16).slice(2)}`; const existingIndex = this.findIndex(m => m.messageId === message.messageId); if (existingIndex !== -1) { this.buffer[existingIndex] = message; } else { this.buffer[this.head] = message; this.head = (this.head + 1) % this.maxSize; if (this.size < this.maxSize) { this.size++; } } }
    findIndex(predicate) { for (let i = 0; i < this.size; i++) { const index = (this.head - this.size + i + this.maxSize) % this.maxSize; if (this.buffer[index] !== undefined && predicate(this.buffer[index])) { return index; } } return -1; }
    getMessages() { const messages = []; for (let i = 0; i < this.size; i++) { const index = (this.head - this.size + i + this.maxSize) % this.maxSize; if (this.buffer[index] !== undefined) { messages.push(this.buffer[index]); } } return messages; }
    clear() { this.buffer = new Array(this.maxSize); this.head = 0; this.size = 0; }
}
messageBuffer = new CircularMessageBuffer(1000);

function normalizeEndpointUrl(url) { try { if (!url || typeof url !== 'string' || ['access-denied-or-invalid', 'unknown-origin', 'null'].includes(url)) { return { normalized: url, components: null }; } let absoluteUrlStr = url; if (!url.includes('://') && !url.startsWith('//')) { absoluteUrlStr = 'https:' + url; } else if (url.startsWith('//')) { absoluteUrlStr = 'https:' + url; } const urlObj = new URL(absoluteUrlStr); if (['about:', 'chrome:', 'moz-extension:', 'chrome-extension:', 'blob:', 'data:'].includes(urlObj.protocol)) { return { normalized: url, components: null }; } const normalized = urlObj.origin + urlObj.pathname + urlObj.search; return { normalized: normalized, components: { origin: urlObj.origin, path: urlObj.pathname, query: urlObj.search, hash: urlObj.hash } }; } catch (e) { return { normalized: url, components: null }; } }
function getBaseUrl(url) { try { const norm = normalizeEndpointUrl(url); return norm?.components ? norm.components.origin + norm.components.path : null; } catch (e) { return null; } }
function addFrameConnection(origin, destinationUrl) { let addedNew = false; try { const normalizedOrigin = normalizeEndpointUrl(origin)?.normalized; const normalizedDestination = normalizeEndpointUrl(destinationUrl)?.normalized; if (!normalizedOrigin || !normalizedDestination || normalizedOrigin === 'null' || normalizedDestination === 'null' || normalizedOrigin === 'access-denied-or-invalid' || normalizedDestination === 'access-denied-or-invalid' || normalizedOrigin === normalizedDestination ) { return false; } if (!frameConnections.has(normalizedOrigin)) { frameConnections.set(normalizedOrigin, new Set()); addedNew = true; } const destSet = frameConnections.get(normalizedOrigin); if (!destSet.has(normalizedDestination)) { destSet.add(normalizedDestination); addedNew = true; } } catch (e) {} return addedNew; }
async function isDashboardOpen() { try { const dashboardUrl = chrome.runtime.getURL("dashboard/dashboard.html"); const tabs = await chrome.tabs.query({ url: dashboardUrl }); return tabs.length > 0; } catch (e) { return false; } }
async function notifyDashboard(type, payload) { if (!(await isDashboardOpen())) return; try { let serializablePayload; try { JSON.stringify(payload); serializablePayload = payload; } catch (e) { if (payload instanceof Map) serializablePayload = Object.fromEntries(payload); else if (payload instanceof Set) serializablePayload = Array.from(payload); else serializablePayload = { error: "Payload not serializable", type: payload?.constructor?.name }; } if (chrome?.runtime?.id) { await chrome.runtime.sendMessage({ type: type, payload: serializablePayload }); } } catch (error) { if (!error.message?.includes("Receiving end does not exist") && !error.message?.includes("Could not establish connection")) {} } }
function agentFunctionToInject() { const AGENT_VERSION = 'v10_postMsg_inline'; const agentFlag = `__frogPostAgentInjected_${AGENT_VERSION}`; if (window[agentFlag]) return { success: true, alreadyInjected: true, message: `Agent ${AGENT_VERSION} already present.` }; window[agentFlag] = true; let errors = []; const MAX_LISTENER_CODE_LENGTH = 15000; const originalWindowAddEventListener = window.addEventListener; const capturedListenerSources = new Set(); const safeToString = (func) => { try { return func.toString(); } catch (e) { return `[Error converting function: ${e?.message}]`; } }; const sendListenerToForwarder = (listenerCode, contextInfo, destinationUrl) => { try { const codeStr = typeof listenerCode === 'string' ? listenerCode : safeToString(listenerCode); if (!codeStr || codeStr.includes('[native code]') || codeStr.length < 25) { return; } const fingerprint = codeStr.replace(/\s+/g, '').substring(0, 250); if (capturedListenerSources.has(fingerprint)) { return; } capturedListenerSources.add(fingerprint); let stack = ''; try { throw new Error('CaptureStack'); } catch (e) { stack = e.stack || ''; } const payload = { listenerCode: codeStr.substring(0, MAX_LISTENER_CODE_LENGTH), stackTrace: stack, destinationUrl: destinationUrl || window.location.href, context: contextInfo }; window.postMessage({ type: 'frogPostAgent->ForwardToBackground', payload: payload }, window.location.origin || '*'); } catch (e) { errors.push(`sendListener Error (${contextInfo}): ${e.message}`); } }; try { window.addEventListener = function (type, listener, options) { if (type === 'message' && typeof listener === 'function') { sendListenerToForwarder(listener, 'window.addEventListener', window.location.href); } return originalWindowAddEventListener.apply(this, arguments); }; } catch (e) { errors.push(`addEventListener hook failed: ${e.message}`); window.addEventListener = originalWindowAddEventListener; } let _currentWindowOnmessage = window.onmessage; try { Object.defineProperty(window, 'onmessage', { set: function (listener) { _currentWindowOnmessage = listener; if (typeof listener === 'function') { sendListenerToForwarder(listener, 'window.onmessage_set', window.location.href); } }, get: function () { return _currentWindowOnmessage; }, configurable: true, enumerable: true }); if (typeof _currentWindowOnmessage === 'function') { sendListenerToForwarder(_currentWindowOnmessage, 'window.onmessage_initial', window.location.href); } } catch (e) { errors.push(`onmessage hook failed: ${e.message}`); } try { const originalPortAddEventListener = MessagePort.prototype.addEventListener; MessagePort.prototype.addEventListener = function (type, listener, options) { try { if (type === 'message' && typeof listener === 'function') { sendListenerToForwarder(listener, 'port.addEventListener', window.location.href); } } catch(e) { errors.push(`port.addEventListener inner: ${e.message}`); } return originalPortAddEventListener.apply(this, arguments); }; const portOnMessageDescriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage'); const originalPortSetter = portOnMessageDescriptor?.set; const originalPortGetter = portOnMessageDescriptor?.get; const portOnmessageTracker = new WeakMap(); Object.defineProperty(MessagePort.prototype, 'onmessage', { set: function(listener) { try { portOnmessageTracker.set(this, listener); if (typeof listener === 'function') { sendListenerToForwarder(listener, 'port.onmessage_set', window.location.href); } if (originalPortSetter) originalPortSetter.call(this, listener); } catch(e) { errors.push(`port.onmessage set inner: ${e.message}`); } }, get: function() { try { let value = portOnmessageTracker.get(this); if (value === undefined && originalPortGetter) value = originalPortGetter.call(this); return value; } catch(e) { errors.push(`port.onmessage get inner: ${e.message}`); return undefined; } }, configurable: true, enumerable: true }); } catch (e) { errors.push(`MessagePort hook failed: ${e.message}`); } return { success: errors.length === 0, alreadyInjected: false, errors: errors, logsAdded: true }; }
async function loadHandlerEndpoints() { try { const result = await chrome.storage.session.get([HANDLER_ENDPOINT_KEYS_STORAGE_KEY]); if (result[HANDLER_ENDPOINT_KEYS_STORAGE_KEY]) { endpointsWithDetectedHandlers = new Set(result[HANDLER_ENDPOINT_KEYS_STORAGE_KEY]); } else { endpointsWithDetectedHandlers = new Set(); } } catch (e) { endpointsWithDetectedHandlers = new Set(); } }
async function saveHandlerEndpoints() { try { await chrome.storage.session.set({ [HANDLER_ENDPOINT_KEYS_STORAGE_KEY]: Array.from(endpointsWithDetectedHandlers) }); } catch (e) {} }
function disconnectNativeHost() { if (nativePort) { nativePort.disconnect(); nativePort = null; } }

async function detachDebugger(debuggee) {
    const sessionKey = `${debuggee.tabId}:${debuggee.frameId || 0}`;
    if (activeDebugSessions.has(sessionKey)) {
        try {
            await new Promise((resolve, reject) => {
                chrome.debugger.detach(debuggee, () => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError); else resolve();
                });
            });
            log.debug(`Debugger detached from ${sessionKey}`);
        } catch (error) {
            log.warn(`Error detaching debugger from ${sessionKey}:`, error.message);
        } finally {
            activeDebugSessions.delete(sessionKey);
        }
    }
}

async function analyzeHandlerDynamically(details, sendResponse) {
    const { targetTabId, targetFrameId = 0, handlerSnippet, pointsOfInterest = [] } = details;
    if (!targetTabId) { sendResponse({ success: false, error: "Missing targetTabId" }); return; }
    const debuggee = { tabId: targetTabId };
    if (targetFrameId !== 0) { debuggee.frameId = targetFrameId; }
    const sessionKey = `${debuggee.tabId}:${debuggee.frameId || 0}`;

    if (activeDebugSessions.has(sessionKey)) {
        sendResponse({ success: false, error: "Debugger session already active for this target" });
        return;
    }

    let results = { variableStates: {}, errors: [] };
    let breakpointId = null;

    try {
        await new Promise((resolve, reject) => {
            chrome.debugger.attach(debuggee, "1.3", () => {
                if (chrome.runtime.lastError) reject(new Error(`Attach failed: ${chrome.runtime.lastError.message}`)); else resolve();
            });
        });
        activeDebugSessions.set(sessionKey, { target: debuggee, status: 'attached' });
        log.debug(`Debugger attached to ${sessionKey}`);

        await new Promise((resolve, reject) => { chrome.debugger.sendCommand(debuggee, "Debugger.enable", {}, () => { if (chrome.runtime.lastError) reject(new Error(`Debugger.enable failed: ${chrome.runtime.lastError.message}`)); else resolve(); }); });

        const scriptSource = await new Promise((resolve, reject) => { chrome.debugger.sendCommand(debuggee, "Debugger.getScriptSource", { scriptId: "SOME_SCRIPT_ID_PLACEHOLDER" }, (result) => { if (chrome.runtime.lastError) reject(new Error(`getScriptSource failed: ${chrome.runtime.lastError.message}`)); else resolve(result?.scriptSource); }); });


        const location = { scriptId: "SOME_SCRIPT_ID_PLACEHOLDER", lineNumber: 0, columnNumber: 0 };

        breakpointId = await new Promise((resolve, reject) => { chrome.debugger.sendCommand(debuggee, "Debugger.setBreakpoint", { location: location }, (result) => { if (chrome.runtime.lastError) reject(new Error(`setBreakpoint failed: ${chrome.runtime.lastError.message}`)); else resolve(result?.breakpointId); }); });
        if (!breakpointId) throw new Error("Failed to set breakpoint.");
        log.debug(`Breakpoint set for ${sessionKey} at simplified location`);


        const eventListener = (source, method, params) => {
            if (source.tabId === debuggee.tabId && (!debuggee.frameId || source.frameId === debuggee.frameId)) {
                if (method === "Debugger.paused" && params.hitBreakpoints?.includes(breakpointId)) {
                    log.debug(`Breakpoint hit for ${sessionKey}`);
                    const callFrameId = params.callFrames[0].callFrameId;
                    Promise.all(pointsOfInterest.map(varName =>
                        new Promise((resolve) => {
                            chrome.debugger.sendCommand(debuggee, "Debugger.evaluateOnCallFrame", { callFrameId: callFrameId, expression: varName, objectGroup: "tempInspect", returnByValue: false, generatePreview: true }, (evalResult) => {
                                if (chrome.runtime.lastError) { results.errors.push(`Eval error for ${varName}: ${chrome.runtime.lastError.message}`); resolve(); }
                                else { results.variableStates[varName] = evalResult?.result; resolve(); }
                            });
                        })
                    )).then(async () => {
                        chrome.debugger.sendCommand(debuggee, "Debugger.resume", {}, () => { if (chrome.runtime.lastError) log.warn(`Resume failed: ${chrome.runtime.lastError.message}`); });
                        await new Promise(resolve => setTimeout(resolve, 500));
                        chrome.debugger.onEvent.removeListener(eventListener);
                        await detachDebugger(debuggee);
                        sendResponse({ success: true, results: results });
                    }).catch(async (evalErr) => {
                        results.errors.push(`Evaluation error: ${evalErr.message}`);
                        chrome.debugger.onEvent.removeListener(eventListener);
                        await detachDebugger(debuggee);
                        sendResponse({ success: false, results: results });
                    });
                } else if (method === "Debugger.resumed") {

                }
            }
        };
        chrome.debugger.onEvent.addListener(eventListener);


        log.debug(`Debugger setup complete for ${sessionKey}. Waiting for breakpoint...`);


    } catch (error) {
        log.error(`Dynamic analysis error for ${sessionKey}:`, error);
        results.errors.push(error.message);
        if (breakpointId) { try { await new Promise(r => chrome.debugger.sendCommand(debuggee, "Debugger.removeBreakpoint", { breakpointId }, r)); } catch {} }
        await detachDebugger(debuggee);
        sendResponse({ success: false, results: results });
    }
}


chrome.debugger.onDetach.addListener((source, reason) => {
    const sessionKey = `${source.tabId}:${source.frameId || 0}`;
    log.warn(`Debugger detached from ${sessionKey}. Reason: ${reason}`);
    activeDebugSessions.delete(sessionKey);
});


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { if (changeInfo.status === 'loading' && tabId) { injectedFramesAgents.delete(tabId); detachDebugger({ tabId: tabId }).catch(()=>{}); } });
chrome.tabs.onRemoved.addListener(tabId => { injectedFramesAgents.delete(tabId); detachDebugger({ tabId: tabId }).catch(()=>{}); });
chrome.webNavigation.onCommitted.addListener(async (details) => { if (!details.url || (!details.url.startsWith('http:') && !details.url.startsWith('https://')) || details.transitionType === 'server_redirect') { return; } const tabFrames = injectedFramesAgents.get(details.tabId); if (tabFrames?.has(details.frameId)) { return; } try { const results = await chrome.scripting.executeScript({ target: { tabId: details.tabId, frameIds: [details.frameId] }, func: agentFunctionToInject, injectImmediately: true, world: 'MAIN' }); let injectionStatus = { success: false, alreadyInjected: false, errors: ["No result from executeScript"] }; if (results?.[0]?.result) { injectionStatus = results[0].result; } else if (results?.[0]?.error) { injectionStatus.errors = [`executeScript framework error: ${results[0].error.message || results[0].error}`]; } if (injectionStatus.success || injectionStatus.alreadyInjected) { if (!injectedFramesAgents.has(details.tabId)) { injectedFramesAgents.set(details.tabId, new Set()); } injectedFramesAgents.get(details.tabId).add(details.frameId); } } catch (error) { if (!error.message?.includes("Cannot access") && !error.message?.includes("No frame with id") && !error.message?.includes("target frame detached") && !error.message?.includes("The frame was removed") && !error.message?.includes("Could not establish connection") && !error.message?.includes("No tab with id")) {} const tf = injectedFramesAgents.get(details.tabId); if (tf) { tf.delete(details.frameId); } } }, { url: [{ schemes: ["http", "https"] }] });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    let isAsync = false; let responseFunction = sendResponse;
    try {
        const messageType = message?.type; const payload = message?.payload; const detail = message?.detail; const payloadIndex = message?.payloadIndex; const senderTabId = sender?.tab?.id;
        switch (messageType) {
            case "runtimeListenerCaptured":
                if (payload) { const { listenerCode, stackTrace, destinationUrl, context } = payload; const normalizedInfo = normalizeEndpointUrl(destinationUrl); const storageIdentifier = normalizedInfo?.normalized; if (listenerCode && storageIdentifier && typeof storageIdentifier === 'string') { const storageKey = `runtime-listeners-${storageIdentifier}`; const isValidListenerCode = code => code && typeof code === 'string' && !code.includes('[native code]') && code.length > 25; isAsync = true; (async () => { let responseSent = false; let response = { success: false, error: "Storage operation did not complete" }; try { const result = await chrome.storage.local.get([storageKey]); let listeners = result[storageKey] || []; const existingIndex = listeners.findIndex(l => l.code === listenerCode); const newListenerData = { code: listenerCode, stack: stackTrace, timestamp: Date.now(), context: context }; let needsEndpointNotification = false; let needsHandlerUpdateNotification = false; if (existingIndex === -1) { listeners.push(newListenerData); if (listeners.length > 30) listeners = listeners.slice(-30); await chrome.storage.local.set({ [storageKey]: listeners }); response = { success: true, action: "saved" }; if (isValidListenerCode(listenerCode)) { needsHandlerUpdateNotification = true; } } else { response = { success: true, action: "duplicate" }; if (isValidListenerCode(listenerCode)) { needsHandlerUpdateNotification = true; } } if (isValidListenerCode(listenerCode)) { if (!endpointsWithDetectedHandlers.has(storageIdentifier)) { endpointsWithDetectedHandlers.add(storageIdentifier); await saveHandlerEndpoints(); needsEndpointNotification = true; } } if (needsEndpointNotification) { notifyDashboard("handlerEndpointDetected", { endpointKey: storageIdentifier }); } if (needsHandlerUpdateNotification) { notifyDashboard("handlerCapturedForEndpoint", { endpointKey: storageIdentifier }); } } catch (error) { response = { success: false, error: error.message }; } finally { if (responseFunction && !responseSent) { try { responseFunction(response); responseSent = true; } catch (e) {} } } })(); return true; } else { if (responseFunction) responseFunction({ success: false, error: "Missing listenerCode or invalid destinationUrl" }); return false; } }
                break;
            case "postMessageCaptured":
                if (payload) { const {origin, destinationUrl, data, timestamp} = payload; let finalData = data; let calculatedMessageType = 'unknown'; if (finalData === undefined) calculatedMessageType = "undefined"; else if (finalData === null) calculatedMessageType = "null"; else if (Array.isArray(finalData)) calculatedMessageType = "array"; else if (typeof finalData === 'object') { calculatedMessageType = finalData.constructor === Object ? "object" : "special_object"; } else if (typeof finalData === 'string') { if ((finalData.startsWith('{') && finalData.endsWith('}')) || (finalData.startsWith('[') && finalData.endsWith(']'))) { try { const parsedData = JSON.parse(finalData); finalData = parsedData; if (Array.isArray(finalData)) calculatedMessageType = "array"; else if (typeof finalData === 'object' && finalData !== null && finalData.constructor === Object) calculatedMessageType = "object"; else calculatedMessageType = "string"; } catch (e) { calculatedMessageType = "string"; } } else { calculatedMessageType = "string"; } } else calculatedMessageType = typeof finalData; const destUrlStr = typeof destinationUrl === 'string' ? destinationUrl : 'unknown_frame_url'; const messageData = { origin: origin || sender.origin || sender.tab?.url || 'unknown', destinationUrl: destUrlStr, data: finalData, messageType: calculatedMessageType, timestamp: timestamp || new Date().toISOString(), messageId: `${timestamp || Date.now()}-${Math.random().toString(16).slice(2)}` }; messageBuffer.push(messageData); const newConnection = addFrameConnection(messageData.origin, messageData.destinationUrl); notifyDashboard('newPostMessage', messageData); if (newConnection) { const connectionsPayload = {}; frameConnections.forEach((v, k) => { connectionsPayload[k] = Array.from(v); }); notifyDashboard('newFrameConnection', connectionsPayload); } }
                if (responseFunction) responseFunction({success: true});
                return false;
            case "FROGPOST_MUTATION":
                notifyDashboard("domMutationDetected", { detail: detail, location: message.location, payloadIndex: payloadIndex });
                return false;
            case "FROGPOST_CONSOLE_SUCCESS":
                if (payloadIndex !== undefined && payloadIndex !== -1) { if (!consoleSuccessIndices.includes(payloadIndex)) { consoleSuccessIndices.push(payloadIndex); } }
                notifyDashboard("consoleSuccessDetected", { detail: detail, location: message.location, payloadIndex: payloadIndex });
                return false;
            case "getConsoleSuccessIndices":
                const indicesToSend = [...consoleSuccessIndices]; consoleSuccessIndices = []; responseFunction({ success: true, indices: indicesToSend }); return true;
            case "fetchInitialState":
                isAsync = true; (async () => { const messages = messageBuffer.getMessages(); const handlerKeys = Array.from(endpointsWithDetectedHandlers); if (responseFunction) { try { responseFunction({ success: true, messages: messages, handlerEndpointKeys: handlerKeys }); } catch (e) {} } })(); return true;
            case "resetState":
                messageBuffer.clear(); frameConnections.clear(); injectedFramesAgents.clear(); endpointsWithDetectedHandlers.clear(); consoleSuccessIndices = [];
                isAsync = true; (async () => { let response = { success: true, message: "State reset" }; try { const allData = await chrome.storage.local.get(null); const keysToRemove = Object.keys(allData).filter(key => key.startsWith('runtime-listeners-') || key.startsWith('best-handler-') || key.startsWith('saved-messages-') || key.startsWith('trace-info-') || key.startsWith('analyzed-url-for-') || key.startsWith('analysis-storage-key-for-')); if (keysToRemove.length > 0) { await chrome.storage.local.remove(keysToRemove); } await chrome.storage.session.remove(HANDLER_ENDPOINT_KEYS_STORAGE_KEY); if (self.traceReportStorage && typeof self.traceReportStorage.clearAllReports === 'function') { await self.traceReportStorage.clearAllReports(); } } catch(storageError) { response = { success: false, message: "Error clearing storage", error: storageError.message }; } finally { if (responseFunction) { try { responseFunction(response); } catch(e) {} } } })(); notifyDashboard('stateReset', {}); return true;
            case 'startServer':
                isAsync = true; chrome.runtime.sendNativeMessage( NATIVE_HOST_NAME, { action: 'startServer', data: JSON.stringify(message.data), options: { port: 1337, maxRetries: 3, timeout: 5000 } }, (response) => { if (chrome.runtime.lastError) { if (responseFunction) try { responseFunction({success: false, error: chrome.runtime.lastError.message}); } catch(e){} } else if (response?.success) { setTimeout(() => { if (responseFunction) try { responseFunction({success: true}); } catch(e){} }, 2000); } else { if (responseFunction) try { responseFunction({success: false, error: response?.error || "Failed to start server"}); } catch(e){} } } ); return true;
            case 'stopServer':
                isAsync = true; chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'stopServer' }, (response) => { if (responseFunction) { try { responseFunction({ success: !chrome.runtime.lastError && response?.success, error: chrome.runtime.lastError?.message || response?.error }); } catch(e){} } }); disconnectNativeHost(); return true;
            case 'analyzeHandlerDynamically':
                isAsync = true; analyzeHandlerDynamically(payload, responseFunction); return true;
            case "contentScriptReady": break; default: break;
        }
    } catch (error) { log.error("Top-level error processing message:", error, message); if (responseFunction) try { responseFunction({ success: false, error: "Handler error" }); } catch (e) {} }
    return isAsync;
});

chrome.action.onClicked.addListener((tab) => { chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") }); });
chrome.runtime.onInstalled.addListener(details => { if (details.reason === 'install' || details.reason === 'update') { chrome.storage.session.remove(HANDLER_ENDPOINT_KEYS_STORAGE_KEY); } messageBuffer = new CircularMessageBuffer(1000); loadHandlerEndpoints(); });
loadHandlerEndpoints();
if (!messageBuffer) { messageBuffer = new CircularMessageBuffer(1000); }
setInterval(() => { chrome.runtime.getPlatformInfo().then(info => {}); }, 25000);
