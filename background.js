/*
 *
 * Copyright (C) 2020 Universitat Politècnica de Catalunya.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

//############################################## GLOBAL VARIABLES ##############################################

//Boolean that indicates if extension's filter is activated or not
var filter = true;

//Boolean to check is allowed sites should be saved between sessions
var save_allowed = true;

//Variables needed for the deep learning model to work
var model;
var dict;

//Info about current open tabs will be handled in this variable
var tabsInfo = new Map();

//User allowed urls/hosts are saved here. Set is used to avoid repeated appearences of an element
var user_allowed_urls = new Set();
var user_allowed_hosts = new Set();

//Whitelisted elements to avoid some false positives that affect some websites functioning, stored in whitelist.json
var whitelisted_matches;

//Content blacklist: a list of SHA-256 hashes for the content-blocker
var hash_blacklist = ["",""];

//Var used for statistical data
var stats_map = new Map();

//change badge color (badge shows the number of suspicious url blocked on a website)
browser.browserAction.setBadgeBackgroundColor({color:'#cf1b1b'});


loadModel();
load_dict();
loadWL();
downloadBlacklist();


browser.storage.sync.get(['allowed_urls'], function(result){
    if(result != undefined && Object.keys(result).length != 0){
        result.allowed_urls.forEach(item => user_allowed_urls.add(item));
        console.debug("URLs recovered from memory: ", result.allowed_urls, user_allowed_urls);
    }
});

browser.storage.sync.get(['allowed_hosts'], function(result){
    if(result != undefined && Object.keys(result).length != 0){
        result.allowed_hosts.forEach(item => user_allowed_hosts.add(item));
        console.debug("Hosts recovered from memory: ", result.allowed_hosts, user_allowed_hosts);
    }
});

// ############################################## WHITELIST FUNCTIONS ##############################################
// purpose of this is to avoid false positive that affects website usability and correct functioning
async function loadWL(){
    let aux;
    await jQuery.getJSON("whitelist.json", function(result) {
        aux = result;
        for (var key in aux) {
            switch (key) {
                case "whitelisted_matches":
                    whitelisted_matches = aux[key];
                    break;
            }
        }
    });
}


// ############################################## INIT FUNCTIONS ##############################################
async function downloadBlacklist(){
    if (await checkHashlistUpdate()) {
        await updateHashlist();
    }
    writeBlacklist();
}


async function writeBlacklist() {
    var aux = await browser.storage.local.get("hashDB_content");
    hash_blacklist = aux.hashDB_content;

    //@debug
    console.debug("hash blacklist loaded");
}


async function getRemoteHashlistHash() {
   var response = await fetch('https://raw.githubusercontent.com/oscarsanchezdm/DTBresources/main/resourcelist_hash.txt');
   var content = await response.text();
   return content;
}


async function getLocalHashlistHash() {
    var aux = await browser.storage.local.get("hashDB_hash");
    return aux.hashDB_hash;
}


async function checkHashlistUpdate() {
    var localHashlistHash = await getLocalHashlistHash();
    var remoteHashlistHash = await getRemoteHashlistHash();

    //@debug
    console.debug("act: " + localHashlistHash);
    console.debug("rem: " + remoteHashlistHash);

    if (localHashlistHash == remoteHashlistHash) { 
        console.debug("hash is up to date!");
        return false; 
    }

    var hashDB_hash = remoteHashlistHash;
    browser.storage.local.set({hashDB_hash});
    return true;
}


async function updateHashlist() {
    //@debug
    console.debug("downloading new hash blacklist.");

    var response = await fetch('https://raw.githubusercontent.com/oscarsanchezdm/DTBresources/main/resourcelist.csv');
    var online_content = (await response.text()).split("\n");
    var hashDB_content = await parseBlacklist(online_content);
    browser.storage.local.set({hashDB_content});
}


async function parseBlacklist(orig_blacklist) {
    var new_blacklist = [];
    for (var i = 0; i < orig_blacklist.length; i++) {
        var aux = orig_blacklist[i].split(',');
        new_blacklist.push([aux[0],aux[1]]);
    }
    return new_blacklist;
}

// ############################################## FUNCIONES PARA EL MODELO ##############################################

//Load model
async function loadModel(){
    model = await tf.loadLayersModel('./model_tfjs-DNN/model.json');
    //model.summary();
}

//load dictionary for preprocessing
async function load_dict(){
    await jQuery.getJSON("dict_url_raw.json", function(jsonDict) {
        dict = jsonDict;
        //al caracter que tiene el 0 asignado como traduccion se lo cambiamos para que no interfiera con el padding,
        //se le da el valor de dict.length que es el immediatamente mas peque siguiente
        for (var key in dict) {
            if (dict.hasOwnProperty(key) && dict[key] == 0) {
                dict[key] = Object.keys(dict).length;
            }
        }
    });
}

//######################### CONTENT-BLOCKER FUNCTIONS #########################
//generates the SHA-256 hash string from an ArrayBuffer
async function hash_func(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);               // hash the message
    const hashArray = Array.from(new Uint8Array(hashBuffer));                     // convert buffer to byte array
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
    return hashHex;
}

//check if resource hashes are blacklisted
async function isOnBlacklist(hash) {
   let binarySearch = function (arr, x, start, end) { 
        if (start > end) return [false,false]; 

        let mid=Math.floor((start + end)/2); 
        if (arr[mid][0] == x && arr[mid][1] == 0) return [true,false]; 
        if (arr[mid][0] == x && arr[mid][1] != 0) return [true,true]; 
        
        if (arr[mid][0] > x) return binarySearch(arr, x, start, mid-1); 
        else return binarySearch(arr, x, mid+1, end); 
    } 

    var ret = await binarySearch(hash_blacklist, hash, 0, hash_blacklist.length-1);
    return ret;
}


//######################### URL PREPROCESSING #########################

function url_preprocessing(url){
    //convertimos la url de string a array de caracteres
    const url_array = Array.from(url);

    //traducimos la url de caracteres a numeros segun el diccionario creado por la notebook (esta depende de la base de datos que utiliza para el training)
    for (i=0; i < url_array.length; i++){
        if(dict != undefined && dict.hasOwnProperty(url_array[i]))
            url_array[i]=dict[url_array[i]];
    }

    //padding a la izquierda
    return Array(200).fill(0).concat(url_array).slice(url_array.length);
}


//######################### INFERENCE TASK #########################
//With a processed url returns an int to say if it has to be blocked or not
function processResult(prepro_url){
    let result = model.predict(tf.tensor(prepro_url,[1, 200]));
    result = result.reshape([2]);
    result = result.argMax(); //aqui tiene el valor que toca pero sigue siendo un tensor
    return result.arraySync(); //Returns the tensor data as a nested array, as it is one value, it returns one int
}


//######################### tabInfo related functions #########################


//function to create a new entry for tabsInfo
function newInfo (tabId){
    browser.tabs.get(tabId,
        function(tab) {
            if (browser.runtime.lastError) {
                //roudabout to error "no tab with id xxx"
                console.debug("Sorry for this: ",browser.runtime.lastError.message);
                return;
            }
            let aux_host;
            try {
                if(tab.url == undefined){
                    return;
                }

                aux_host = new URL(tab.url).host;

                baseHost = aux_host.split(".");
                baseHost = baseHost.slice(baseHost.length-2, baseHost.length);
                baseHost = (baseHost[0]+"."+baseHost[1]);

                let info = {
                    id: tabId,
                    url: tab.url,
                    blocked_index: [],
                    blocked: [],
                    host: aux_host,
                    baseHost: baseHost,
                };
                tabsInfo.set(tabId,info);
            } catch (e) {
                //if you load something that's not a website, error, like local files
                console.debug("Visited site is not an URL");
            }
        }
    );
}

function updateTabInfo (idTab, aux_URL){
        let check_value;
        if(user_allowed_hosts.has(aux_URL.host)){
            check_value = true;
        }
        else{
            check_value = user_allowed_urls.has(aux_URL.href);
        }

        let blocked_info = {
            url: aux_URL.href,
            host: aux_URL.host,
            check: check_value,
        }

        tabsInfo.get(idTab).blocked_index.push(aux_URL.href);
        tabsInfo.get(idTab).blocked.push(blocked_info);

        tabsInfo.set(idTab,  tabsInfo.get(idTab));

        browser.browserAction.setBadgeText(
            {tabId: idTab, text: ((tabsInfo.get(idTab).blocked.length).toString())}
        );
}

//######################### other functions #########################
//this section is to ensure functionality in some cases were falses positves where dicovered
function isSpecialCase(aux_URL, tabHost){
    if(aux_URL.host.includes("fbcdn.net") && tabHost.includes("facebook.com")){
        return true; //visiting facebook
    }
    if(aux_URL.host.includes("twitchcdn.net") && tabHost.includes("twitch.tv")){
        return true; //visiting twitch
    }
    if(aux_URL.host.includes("lolstatic") && tabHost.includes("leagueoflegends.com")){
       return true;
    }
    if(aux_URL.host.includes("poecdn") && tabHost.includes("pathofexile.com")){
        return true;
    }
    if(aux_URL.host.includes("outlook") && tabHost.includes("outlook.live.com")){
        return true;
    }
    if(aux_URL == "https://www.google.com/recaptcha/api.js"){
        return true;
    }

    return false;
}


function saveStorageURLS(){
    if (save_allowed) {
        let arrayURLs = Array.from(user_allowed_urls.values());

        browser.storage.sync.set({ ['allowed_urls'] : arrayURLs }, function(){
            console.debug('URLs saved succesfully: ', arrayURLs);
        });
    }
}

function saveStorageHosts(){
    if (save_allowed) {
        let arrayHosts = Array.from(user_allowed_hosts.values());

        browser.storage.sync.set({ ['allowed_hosts'] : arrayHosts }, function(){
            console.debug('Hosts saved succesfully', arrayHosts);
        });
    }

}

// ################ STAT GENERATION
//message listener

function handleMessage(message, sender) {
    // check that the message is from "blue@mozilla.org"
    if (sender.id === "DTBstatgen_ublock@upc.edu") {
        //message[0] tabID message[1] requestID message[2] blocked
        generateStats(message[0],message[1],undefined,undefined,message[2]);
    }
  }
  
browser.runtime.onMessageExternal.addListener(handleMessage);

function generateStats(tabID,str_requestID,blocked_DTB,blocked_Hash,blocked_uBlock) {
    var requestID = parseInt(str_requestID);
    var key = [tabID,requestID].toString();

    if (!stats_map.has(key)) {
        stats_map.set(key,[blocked_DTB,blocked_Hash,blocked_uBlock]);   
    } else {
        var old_blocked_DTB = stats_map.get(key)[0];
        var old_blocked_Hash = stats_map.get(key)[1];
        var old_blocked_uBlock = stats_map.get(key)[2];

        if (typeof blocked_DTB !== "boolean") {
            blocked_DTB = old_blocked_DTB;   
        }
        if (typeof blocked_Hash !== "boolean") {
            blocked_Hash = old_blocked_Hash;   
        }
        if (typeof blocked_uBlock !== "boolean") {
            blocked_uBlock = old_blocked_uBlock;   
        }
        stats_map.set(key,[blocked_DTB,blocked_Hash,blocked_uBlock]);   
    }
}

function clearStatsMap(tabID) {
    for (var key of stats_map.keys()) {
        if (parseInt(key.split(",")[0])-tabID == 0) {
            stats_map.delete(key);
        }
      }
}

async function sendStats(tabID) {
    var tabmap = new Map();
    for (var [key, value] of stats_map) {
        if (parseInt(key.split(',')[0])-tabID == 0) {
            tabmap.set(key,value);
        }
    }

    //the tabmap contains keys for every requestID. these keys will be compared with the keys generated by the modified version of uBlock
    if (typeof tabmap == 'undefined') { 
        return;
    }

    /*
        @TO-DO: READ DATA WRITTEN BY UBLOCK
    */

    var blocked = 0; //nr of petitions blocked by the plugin

    var blocked_DTB = 0; //nr of petitions blocked by DTB URL blocking
    var blocked_hash = 0; //nr of petitions blocked by hash blocking
    var blocked_ublock = 0; //nr of petitions blocked by ublock

    var blocked_DTB_ublock = 0; //nr of petitions blocked by ublock and DTB
    var blocked_DTB_hash = 0; //nr of petitions blocked by DTB and ublock
    var blocked_hash_ublock = 0; //nr of petitions blocked by ublock and hash
    var blocked_DTB_hash_ublock = 0; //nr of petitions blocked by ublock, DTB and hash

    var total = tabmap.size; //nr of petitions
    
    //webrequest[0] blocked by DTB
    //webrequest[1] blocked by hash/content
    //webrequest[2] blocked by uBlock
    for (var webrequest of tabmap.values()) {
        var prev_blocked = blocked;
        if (webrequest[0] == true) {
            blocked = prev_blocked + 1;
            ++blocked_DTB;
        }
        if (webrequest[1]==true) { 
            blocked = prev_blocked + 1;
            ++blocked_hash;
        }
        if (webrequest[2]==true) { 
            //blocking by ublock will not increment the blocked counter as it has not been blocked by the plugin
            ++blocked_ublock;
        }
        if ((webrequest[0] == true) && (webrequest[1]==true)) {
            ++blocked_DTB_hash;
        }
        if ((webrequest[0] == true) && (webrequest[2]==true)) {
            ++blocked_DTB_ublock;
        }
        if ((webrequest[1]==true) && (webrequest[2]==true)) {
            ++blocked_hash_ublock;
        }
        if ((webrequest[0] == true) && (webrequest[1]==true) && (webrequest[2]==true)) {
            ++blocked_DTB_hash_ublock;
        }
    }

    clearStatsMap(tabID);

    //@debug
    //console.debug([total,blocked,blocked_DTB,blocked_hash,blocked_ublock]);
    
    var json = new Object();
    json.total = total;
    json.blocked = blocked;
    json.blockedDTB = blocked_DTB;
    json.blockedhash = blocked_hash;
    json.blockedublock = blocked_ublock;
    json.blockedDTBublock = blocked_DTB_ublock;
    json.blockedDTBhash = blocked_DTB_hash;
    json.blockedhashublock = blocked_hash_ublock;
    json.blockedDTBhashublock = blocked_DTB_hash_ublock;

    //console.debug(JSON.stringify(json));
    console.debug(json)

    /*
        @TO-DO: SEND STATS TO THE SERVER
    */
    postRequest(JSON.stringify(json));
}

function postRequest(json) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", 'http://10.211.55.5:9000/block_stats/', true);

    //Send the proper header information along with the request
    xhr.setRequestHeader("Content-Type", "application/json");

    xhr.onreadystatechange = function() { // Call a function when the state changes.
        if (this.readyState === XMLHttpRequest.DONE && this.status === 200) {
            console.debug("post sent!");
        }
    }
    xhr.send(json);
}



// ############################################## STATS SUBMISSION ##############################################
// The previous visited website stats will be submited [on URL change].
function handleUpdated(tabId, changeInfo, tabInfo) {
    if (changeInfo.url) {
        sendStats(tabId);
    }
  }
browser.tabs.onUpdated.addListener(handleUpdated);

// ############################################## REQUEST PROCESSING ##############################################
browser.webRequest.onBeforeRequest.addListener(
    function(details){
        var blockedbyDTB = false;
        //this is a callback function executed when details of the webrequest are available

        //check if extension is enabled
        if(!filter){
            return;
        }

        const request_url = details.url;
        const idTab = details.tabId;

        //needed when tab created in background
        if(idTab >= 0 && !tabsInfo.has(idTab)){
            newInfo(idTab);
        }

        if(tabsInfo.get(idTab) == undefined){
            return;
        }

        let aux_URL = new URL(request_url);
        let tabHost = tabsInfo.get(idTab).host;

        //allow first party reuqest
        if(aux_URL.host.includes(baseHost)){
            return;
        }

        let suspicious = 0; //here will be stored the url once is preprocessed
        let prepro_url = url_preprocessing(request_url);

        suspicious = processResult(prepro_url);


        //if it is classified as tracking, is added to tab info
        if (suspicious && tabsInfo.has(idTab)){
            //console.debug("Classified as suspicous", request_url, aux_URL.host, " Web host:", tabHost);

            //allow requests in some special cases where correct functionality is broken otherwise
            if(isSpecialCase(aux_URL, tabHost)){
                console.debug("Allowed by special cases list: ", request_url);
                return;
            }

            //checks whitelist
            for(var key in whitelisted_matches){
                if(aux_URL.host.includes(whitelisted_matches[key])){
                    console.debug("Allowed by matches whitelist: ", request_url);
                    return;
                }
            }

            //if its not whitelisted, show it on popup
            updateTabInfo(idTab,aux_URL);


            //if user has allowed it, don't cancel request
            if (user_allowed_hosts.has(aux_URL.host) || user_allowed_urls.has(request_url)) {
                console.debug("Allowed by excepcions list: ", request_url);
                return;
            }

            //DEBUG
            /*
                @TO-DO: enable these lines again
            */

            //generateStats(details.tabId,details.requestId,true,false,undefined);
            //console.debug(details.requestId + " Blocked by url: " + details.url);

            blockedbyDTB = true;
            /*
                @TO-DO: replace the previous line by the following one. DISABLED FOR STATS GENERATION
                return {cancel: true};
            */
        };

        //CONTENT BLOCKER
        var filterReq = browser.webRequest.filterResponseData(details.requestId);
        let tmp_data = [];

        filterReq.ondata = event => {
            tmp_data.push(event.data);
        };

        filterReq.onstop = async event => {
            /*
                @TO-DO: CHECK WHITELIST
            */

            let auxblob = new Blob(tmp_data);
            let data = await new Response(auxblob).arrayBuffer();

            let hash = await hash_func(data); 
            let isTracking = await isOnBlacklist(hash);

            var block = false;

            if (blockedbyDTB == true) { 
                /*
                    @TO-DO: remove this if statement. this is only for stats generation purposes.
                */
               block = true;
               if (isTracking[0]) {
                    generateStats(details.tabId,details.requestId,true,true,undefined);
                    console.debug(details.requestId + " Blocked by DTB and content blocker: " + details.url);
               } else {
                    generateStats(details.tabId,details.requestId,true,false,undefined);
                    console.debug(details.requestId + " Blocked by DTB: " + details.url);
               }
               blockedbyDTB = false;
               
            } else if (isTracking[0]) {
                block = true;
                if (isTracking[1]) {
                    /*
                        @TO-DO: REPLACEMENT
                    */
                    generateStats(details.tabId,details.requestId,false,true,undefined);
                    console.debug(details.requestId + " Blocked and replaced by content blocker: " + details.url);
                } else {
                    generateStats(details.tabId,details.requestId,false,true,undefined);
                    console.debug(details.requestId + " Blocked by content blocker: " + details.url);
                }

                //add info to tabinfo
                let aux_URL = await new URL(request_url);
                updateTabInfo(details.tabId,aux_URL);

            } else {
                generateStats(details.tabId,details.requestId,false,false,undefined);
            }
            await writeFilter(filterReq,block,data);
        }

        async function writeFilter(filter,isTracking,data) {
            if (isTracking) {
                //canviar estat a blocked?
                filter.close();
                
            } else {
                filter.write(data);
                filter.close();
            }
        }

        async function writeReplacementFilter(filter,hash) {
            //write function content here
        }
    },
    {urls: ["<all_urls>"]},
    ["blocking"]
);



// ############################################## TABS LISTENERS ##############################################
var current_tab;
//on activated tab, creates new tabInfo if tab visited is not registered
browser.tabs.onActivated.addListener(
    function(activeInfo){
        current_tab = activeInfo.tabId;
        if(tabsInfo.has(activeInfo.tabId)){
            return;
        }
        newInfo(activeInfo.tabId);
        console.debug(tabsInfo);
    }
);


//on updated tab, creates new tabInfo when page is reloaded or url is changed
browser.tabs.onUpdated.addListener(
    function(tabId, changeInfo){
        if((changeInfo.url != undefined) && tabsInfo.has(tabId)){
            newInfo(tabId);
            browser.browserAction.setBadgeText(
                {tabId: tabId, text: ('')}
            );
        }
        else{
            return;
        };

    }
);


//on removed, remove tabInfo when a tab is closed
browser.tabs.onRemoved.addListener(
    function(tabId){
        if(!tabsInfo.has(tabId)){
            return;
        }
        tabsInfo.delete(tabId);
    }
);

//it save the allowed sites in storage when a window is closed
browser.windows.onRemoved.addListener(function (windowid){
    saveStorageURLS();
    saveStorageHosts();
});


// ############################################## CONNECTIONS WITH POPUP ##############################################
browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
	switch (request.method)
	{
    case 'get_enabled':
        sendResponse(filter);
        break;
    case 'filterCheck':
        filter = request.data;
        break;

    case 'get_enabled_SA':
        sendResponse(save_allowed);
        break;
    case 'save_allowed_changed':
        save_allowed = request.data;
        break;

    // URL excepction management
    case 'add_url_exception':
        user_allowed_urls.add(request.data);
        if(tabsInfo.has(current_tab)){
            let i = tabsInfo.get(current_tab).blocked_index.indexOf(request.data);
            tabsInfo.get(current_tab).blocked[i].check =true;
        }
        saveStorageURLS();
        break;
    case 'delete_url_exception':
        if(user_allowed_urls.has(request.data)){
            user_allowed_urls.delete(request.data);
            if(tabsInfo.has(current_tab)){
                let i = tabsInfo.get(current_tab).blocked_index.indexOf(request.data);
                tabsInfo.get(current_tab).blocked[i].check =false;
            }
        }
        saveStorageURLS();
        break;
    // host excepction management
        case 'add_host_exception':
            user_allowed_hosts.add(request.data);
            saveStorageHosts();
            break;
        case 'delete_host_exception':
            if(user_allowed_hosts.has(request.data)){
                user_allowed_hosts.delete(request.data);
            }
            saveStorageHosts();
            break;

    case 'get_allowed_hosts':
        sendResponse(Array.from(user_allowed_hosts));
        break;
    case 'get_blocked_urls':
        if(tabsInfo.has(current_tab)){
            //console.debug("Request received, sending data...", tabsInfo.get(current_tab).blocked);
            sendResponse(tabsInfo.get(current_tab).blocked);
        }
        break;
	}

    //this is to prevent error message "Unchecked runtime.lastError: The message port closed before a response was received." from appearing needlessly
    sendResponse();
});
