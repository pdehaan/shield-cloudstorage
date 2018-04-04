ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.defineModuleGetter(this, "CloudStorage",
                               "resource://gre/modules/CloudStorage.jsm");
ChromeUtils.defineModuleGetter(this, "Downloads",
                               "resource://gre/modules/Downloads.jsm");
ChromeUtils.defineModuleGetter(this, "DownloadPaths",
                               "resource://gre/modules/DownloadPaths.jsm");
ChromeUtils.defineModuleGetter(this, "FileUtils",
                               "resource://gre/modules/FileUtils.jsm");
ChromeUtils.defineModuleGetter(this, "NetUtil",
                               "resource://gre/modules/NetUtil.jsm");
ChromeUtils.defineModuleGetter(this, "OS",
                               "resource://gre/modules/osfile.jsm");
ChromeUtils.defineModuleGetter(this, "PlacesUtils",
                               "resource://gre/modules/PlacesUtils.jsm");
ChromeUtils.defineModuleGetter(this, "RecentWindow",
                               "resource:///modules/RecentWindow.jsm");

const EXPORTED_SYMBOLS = ["CloudDownloadsView"];
const CLOUD_SERVICES_PREF = "cloud.services.";
const CLOUD_PROVIDER_DEFAULT_ICON = "default";
const Ci = Components.interfaces;

var CloudDownloadsView = {
  isInitialized: false,
  stylesURL: null,
  providers: null,
  notificationHTML: `
    <hbox>
      <image id='cloudDownloadTypeIcon'/>
      <vbox id='cloudDownloadContainer'>
        <description id='cloudDownloadTitle'/>
        <hbox>
          <description id='cloudDownloadDetail'/>
          <label id='cloudDownloadPreference' class='text-link'/>
        </hbox>
        <radiogroup id='multiProviderSelect'/>
      </vbox>
    </hbox>
    <hbox>
      <button id='cloudDownloadCancel' class='cloudNotificationButton'/>
      <button id='cloudDownloadSave' class='cloudNotificationButton' default='true'/>
    </hbox>
    <hbox id='syncSignIn' class='cloudDownloadSyncMessage'>
      <label id='syncSignInLink' class='text-link'/>
      <description id='cloudDownloadSignInText'/>
    </hbox>
    <hbox id='syncMessage' class='cloudDownloadSyncMessage'>
      <description id='cloudDownloadSyncText'/>
    </hbox>`,

  get browserWindow() {
    return RecentWindow.getMostRecentBrowserWindow();
  },

  _formatProviderName(name) {
    return name.toLowerCase().replace(" ", "");
  },

  async registerContextMenu() {
    let browserWindow = this.browserWindow;

    if (!browserWindow || !browserWindow.document) {
      return;
    }

    // Invoke getDownloadFolder on CloudStorage API to ensure API is initialized
    // This is workaround to force initialize API for first time enter to
    // ensure getStorageProviders call returns successfully.
    await CloudStorage.getDownloadFolder();
    this.providers = await CloudStorage.getStorageProviders();


    // Continue only if cloud providers exists on user device
    if (this.providers.size === 0) {
      return;
    }

    let aPopupMenu = browserWindow.document.getElementById("downloadsContextMenu");
    if (!aPopupMenu) {
      return;
    }

    // TBD: Render multiple providers in context menu
    let menuItem = aPopupMenu.getElementsByAttribute("command", "downloadsCmd_copyLocation")[0];
    if (menuItem) {
      let fragment = browserWindow.document.createDocumentFragment();
      let separator = browserWindow.document.createElement('menuseparator');
      fragment.appendChild(separator);

      // Add skeleton Move to menu item in context menu
      let moveDownloadItem = browserWindow.document.createElement('menuitem');
      moveDownloadItem.setAttribute('id', 'moveDownload');
      moveDownloadItem.setAttribute('hidden', 'true');
      fragment.appendChild(moveDownloadItem);
      aPopupMenu.insertBefore(fragment, menuItem.nextSibling);
    }

    aPopupMenu.addEventListener("click", this);

    let dwnldsListBox = browserWindow.document.getElementById("downloadsListBox");
    dwnldsListBox.addEventListener("contextmenu", this);
  },

  unRegisterContextMenu() {
    let browserWindow = this.browserWindow;

    let moveDownloadMenuItem = browserWindow.document.getElementById("moveDownload");
    if (!moveDownloadMenuItem) {
      return;
    }

    let aPopupMenu = browserWindow.document.getElementById("downloadsContextMenu");
    aPopupMenu.removeEventListener("click", this);
    aPopupMenu.removeChild(moveDownloadMenuItem);

    // TBD: Remove menuseperator

    let dwnldsListBox = browserWindow.document.getElementById("downloadsListBox");
    dwnldsListBox.removeEventListener("contextmenu", this);
  },

  async registerNotification() {
    Services.obs.addObserver(this.observe, "cloudstorage-prompt-notification");
    this.isInitialized = true;
  },

  unRegisterNotification() {
    Services.obs.removeObserver(this.observe, "cloudstorage-prompt-notification");
    this.isInitialized = false;
    let browserWindow = this.browserWindow;
    let panelCloudNotification = browserWindow.document.getElementById("panelCloudNotification");
    if (!panelCloudNotification) {
      return;
    }
    panelCloudNotification.removeEventListener("click", this);

    let panelDownload = browserWindow.document.getElementById("downloadsPanel-mainView");
    panelDownload.removeChild(panelCloudNotification);
  },

  initWindowListener() {
    // Get the list of browser windows already open
    let windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
      WindowListener.setupBrowserUI(domWindow);
    }

    // Wait for any new browser windows to open
    Services.wm.addListener(WindowListener);
  },

  uninitWindowListener() {
    // Get the list of browser windows already open
    let windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);

      WindowListener.tearDownBrowserUI(domWindow);
    }
    // Stop listening for any new browser windows to open
    Services.wm.removeListener(WindowListener);
  },

  async init() {
    if (!this.gIsAPIEnabled) {
      if (this.isInitialized) {
        this.unRegisterNotification();
        this.unRegisterContextMenu();
        this.uninitWindowListener();
      }
      return;
    }
    this.initWindowListener();
    await this.registerNotification();
    await this.registerContextMenu();
  },

  async observe(subject, topic, data) {
    switch (topic) {
      case "cloudstorage-prompt-notification":
        await CloudDownloadsView.showNotification();
        break;
    }
  },

  async showNotification() {
    let browserWindow = this.browserWindow;

    if (!browserWindow || !browserWindow.document) {
      return;
    }

    let panelDownload = browserWindow.document.getElementById("downloadsPanel-mainView");
    if (!panelDownload) {
      return;
    }

    // Check if user had already opted-in or
    // enough time has passed since last prompts shown
    // TBD: optimize by implementing lastpromptshown check, getPreferredProvider from cloud storage
    if (!await CloudStorage.promisePromptInfo()) {
      return;
    }

    let panelCloudNotification = browserWindow.document.getElementById("panelCloudNotification");
    if (panelCloudNotification) {
      if (!panelCloudNotification.getAttribute("show")) {
       panelCloudNotification.setAttribute("show", "true");
      }
      return;
    }

    let providersMap = this.providers;

    // Continue only if cloud providers exists on user device
    if (providersMap.size === 0) {
      return;
    }

    // TBD: check if user has browser.download.dir set to one of the default download paths
    // If yes don't continue
    let providerDisplayName = null;
    let providerIcon = null;
    let providerKey = null;
    let document = browserWindow.document;
    let contentStylesheet = document.createProcessingInstruction(
      "xml-stylesheet",
      'href="' + this.stylesURL + '" type="text/css"'
      );

    document.insertBefore(contentStylesheet,
                          document.documentElement);

    let fragment = document.createDocumentFragment();
    panelCloudNotification = document.createElement('vbox');
    panelCloudNotification.setAttribute('id', 'panelCloudNotification');
    panelCloudNotification.unsafeSetInnerHTML(this.notificationHTML);
    fragment.appendChild(panelCloudNotification);
    panelDownload.prepend(fragment);

    if (providersMap.size > 1 ) {
      this._addNotificationMultipleProviders(providersMap, document);
      providerDisplayName = "cloud storage";
      providerIcon = CLOUD_PROVIDER_DEFAULT_ICON;
    } else {
      let provider = providersMap.entries().next().value;
      providerDisplayName = provider[1].displayName;
      providerKey = provider[0];
      providerIcon = this._formatProviderName(providerDisplayName);
    }

    document.getElementById("cloudDownloadTitle").setAttribute("value", "Save downloads to " + providerDisplayName + "?");
    document.getElementById("cloudDownloadTypeIcon").setAttribute("data-provider-icon", providerIcon);
    document.getElementById("cloudDownloadDetail").setAttribute("value", "Change your download settings any time in");
    document.getElementById("cloudDownloadPreference").setAttribute("value", "Preferences.");

    let cloudDownloadSave = document.getElementById("cloudDownloadSave");
    cloudDownloadSave.setAttribute("label", "Save to " + providerDisplayName);
    cloudDownloadSave.setAttribute("key", providerKey);

    if (providerIcon === CLOUD_PROVIDER_DEFAULT_ICON) {
      cloudDownloadSave.setAttribute("disabled", true);
    } else {
      cloudDownloadSave.removeAttribute("disabled");
    }

    document.getElementById("cloudDownloadCancel").setAttribute("label", "Not Now");
    panelCloudNotification.setAttribute("show", "true");
    panelCloudNotification.addEventListener("click", this);
  },

  _addRadioOption(key, providerName, document) {
    let option = document.createElement("radio");
    option.id = key;
    option.type = "radio";

    option.setAttribute("label", "Save to " + providerName);
    option.setAttribute("provider", this._formatProviderName(providerName));
    option.setAttribute("selected", false);
    return option;
  },

  _addNotificationMultipleProviders(providersMap, document) {
    let multiProviderSelect = document.getElementById("multiProviderSelect");

    let providers = [];
    providersMap.forEach((value, key) => {
      providers.push({"key": key, "name": value.displayName});
    });

    // Reset multiProviderSelect by removing any previous
    // added options
    while (multiProviderSelect.firstChild) {
      multiProviderSelect.firstChild.remove();
    }

    for (let provider of providers) {
      multiProviderSelect.appendChild(
        this._addRadioOption(provider.key, provider.name, document));
    }
    multiProviderSelect.setAttribute("show", "true");
  },

  _iconURL(name) {
   return new URL(this.stylesURL).origin + "/skin/" + this._formatProviderName(name) + ".svg";
  },

  _listItemIndex(element) {
    var children = element.parentNode.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (children[i] == element) {
        return i;
      }
    }
    return -1;
  },

  _displayMoveToCloudContextMenuItem(downloadElement) {
    let aPopupMenu = this.browserWindow.document.getElementById("downloadsContextMenu");
    let menuItem = aPopupMenu.getElementsByAttribute("id", "moveDownload")[0];
    if (menuItem) {
      menuItem.setAttribute("hidden", "true");
      let downloadType = downloadElement._shell.element.getAttribute("cloudstorage");

      // TBD: handle multiple providers in context menu when available
      if (downloadType === "local") {
        // move to first provider available
        let provider = this.providers.entries().next().value;
        menuItem.setAttribute('label', 'Move to ' + provider[1].displayName);
        menuItem.setAttribute('key', provider[0]);
        menuItem.setAttribute("class", "menuitem-iconic");
        menuItem.setAttribute("image", this._iconURL(provider[1].displayName));
        menuItem.setAttribute("itemIndex", this._listItemIndex(downloadElement));
        menuItem.removeAttribute('hidden');
      }
    }
  },

  handleEvent(event) {
    // Handle multiple providers options in notification
    if (event.target.parentElement.id === "multiProviderSelect") {
      let cloudDownloadSave = event.currentTarget.children[1].children.cloudDownloadSave;
      cloudDownloadSave.setAttribute("label", event.target.label);
      cloudDownloadSave.setAttribute("key", event.target.id);
      cloudDownloadSave.removeAttribute("disabled");
      return;
    }

    // Handle rendering right provider in context menu when shown
    if (event.type === "contextmenu" && event.currentTarget.id === "downloadsListBox") {
      let element = event.currentTarget.selectedItem;
      if (!element) {
        return;
      }
      this._displayMoveToCloudContextMenuItem(element);
    }

    switch (event.target.id) {
      case "moveDownload":
        console.log(event.target);
        let key = event.target.getAttribute("key");
        CloudDownloadsInternal.prefCloudProvider = { key: key, value: this.providers.get(key) };
        CloudDownloadsInternal.handleMove(event.target);
        break;
      case "cloudDownloadSave":
        CloudStorage.savePromptResponse(event.target.getAttribute("key"), true, true);
        event.currentTarget.removeAttribute("show");
        break;
      case "cloudDownloadCancel":
        // Set interval when notification was last shown
        Services.prefs.setIntPref(CLOUD_SERVICES_PREF + "lastprompt",
                                  Math.floor(Date.now() / 1000));
        event.currentTarget.removeAttribute("show");
        break;
      case "cloudDownloadPreference":
        let origin = null;
        let entryPoint = "CloudStorage";
        this.browserWindow.openPreferences("paneGeneral", {origin, urlParams: {entrypoint: entryPoint}});
        break;
    }
  },
};


// Cloud Downloads Internal API that observe downloads and handle
// downloaded item move once user selects Move to provider folder context menu option
var CloudDownloadsInternal = {
  /**
   * Provider selected in context menu
   */
  prefCloudProvider: null,

  /**
   * Checks if the asset with input path exist on
   * file system
   * @return {Promise}
   * @resolves
   * boolean value of file existence check
   */
  checkIfAssetExists(path) {
    return OS.File.exists(path).catch(err => {
      Cu.reportError(`Couldn't check existance of ${path}`, err);
      return false;
    });
  },

  /**
   * Moves downloaded item to provider download folder and adds
   * moved file in provider folder as a download item in DownloadList
   * object shown in user interface in Download Panel and Download History
   *
   * @param download
   *        object representing a single download
   * @param providerDwnldFldrPath
   *        String with complete path of provider download folder
   * @return {Promise} that resolves successfully once download is moved
   *         to provider folder and movedDownload is added as download item
   *         in DownloadList object
   */

  async _moveDownload(download, providerDwnldFldrPath) {
    // String with complete original target path of download
    let dwnldTargetPath = download.target.path;
    let destPath = providerDwnldFldrPath ?
      OS.Path.join(providerDwnldFldrPath, OS.Path.basename(dwnldTargetPath)) : "";

    // Ensure destPath is a unique file
    destPath = DownloadPaths.createNiceUniqueFile(new FileUtils.File(destPath)).path;

    try {
      await OS.File.move(dwnldTargetPath, destPath);
    } catch (err) {
      Cu.reportError(err);
      return;
    }

    // Create a duplicate download which will show the correct
    // target path for moved session download in Download UI panel
    let publicList = await Downloads.getList(Downloads.ALL);

    let movedDownload = await Downloads.createDownload({
      source: download.source,
      target: destPath
    });
    movedDownload.startTime = download.startTime;
    movedDownload.succeeded = true;
    await publicList.add(movedDownload);

    // Update destination path used in download history library panel
    PlacesUtils.annotations.setPageAnnotation(
      NetUtil.newURI(download.source.url),
      "downloads/destinationFileURI",
      "file://" + destPath, 0,
      PlacesUtils.annotations.EXPIRE_WITH_HISTORY);

    // Explicitly updates the state of a moved download
    movedDownload.refresh().catch(Cu.reportError);

    // Remove original download in favor of moved download from download UI panel
    await publicList.remove(download);
  },

  async handleMove(moveDownloadMenuItem) {
    if (!this.prefCloudProvider) {
      return;
    }

    // Compute provider download folder path from prefCloudProvider object
    let providerDownloadFolder = OS.Path.join(this.prefCloudProvider.value.downloadPath,
      this.prefCloudProvider.value.typeSpecificData["default"]);

    // create download directory if it doesn't exist
    try {
      await OS.File.makeDir(providerDownloadFolder, {ignoreExisting: true});
    } catch (err) {
      Cu.reportError(err);
      return;
    }

    let document = CloudDownloadsView.browserWindow.document;
    let downloadItemElements = document.getElementById("downloadsListBox").childNodes;
    let download = downloadItemElements[moveDownloadMenuItem.getAttribute("itemIndex")]._shell.download;
    if (download.succeeded) {
      await this._moveDownload(download, providerDownloadFolder);
    }
  },
};


var WindowListener = {
  setupBrowserUI: function wm_setupBrowserUI(window) {
    let utils = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);
    utils.loadSheetUsingURIString(CloudDownloadsView.stylesURL, Ci.nsIDOMWindowUtils.AGENT_SHEET);
  },

  tearDownBrowserUI: function wm_tearDownBrowserUI(window) {
    let utils = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);
    utils.removeSheetUsingURIString(CloudDownloadsView.stylesURL, Ci.nsIDOMWindowUtils.AGENT_SHEET);
  },

  // nsIWindowMediatorListener functions
  onOpenWindow: function wm_onOpenWindow(xulWindow) {
    // A new window has opened
    let domWindow = xulWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                             .getInterface(Ci.nsIDOMWindow);

    // Wait for it to finish loading
    domWindow.addEventListener("load", function listener() {
      // If this is a browser window or places library window then setup its UI
      if (domWindow.document.documentElement.getAttribute("windowtype") == "navigator:browser" ||
          domWindow.document.documentElement.getAttribute("windowtype") == "Places:Organizer" ) {
        WindowListener.setupBrowserUI(domWindow);
      }
    }, {once: true});
  },
};

/**
 * generic pref that shows if cloud storage API is in use, by default set to false.
 */
XPCOMUtils.defineLazyPreferenceGetter(CloudDownloadsView, "gIsAPIEnabled",
  CLOUD_SERVICES_PREF + "api.enabled", false, () => CloudDownloadsView.init());

CloudDownloadsView.promiseInit = CloudDownloadsView.init();