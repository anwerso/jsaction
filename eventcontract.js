// Copyright 2005 Google Inc. All Rights Reserved.

/**
 *
 * @fileoverview Implements the local event handling contract. This
 * allows DOM objects in a container that enters into this contract to
 * define event handlers which are executed in a local context.
 *
 * One EventContract instance can manage the contract for multiple
 * containers, which are added using the addContainer() method.
 *
 * Events can be registered using the addEvent() method.
 *
 * A Dispatcher is added using the dispatchTo() method. Until there is
 * a dispatcher, events are queued. The idea is that the EventContract
 * class is inlined in the HTML of the top level page and instantiated
 * right after the start of <body>. The Dispatcher class is contained
 * in the external deferred js, and instantiated and registered with
 * EventContract when the external javascript in the page loads. The
 * external javascript will also register the jsaction handlers, which
 * then pick up the queued events at the time of registration.
 *
 * Since this class is meant to be inlined in the main page HTML, the
 * size of the binary compiled from this file MUST be kept as small as
 * possible and thus its dependencies to a minimum.
 */

goog.provide('jsaction.EventContract');
goog.provide('jsaction.EventContractContainer');

goog.require('goog.dom.TagName');
goog.require('jsaction.Attribute');
goog.require('jsaction.Cache');
goog.require('jsaction.Char');
goog.require('jsaction.EventType');
goog.require('jsaction.Property');
goog.require('jsaction.createMouseEvent');
goog.require('jsaction.domGenerator');
goog.require('jsaction.event');



/**
 * EventContract intercepts events in the bubbling phase at the
 * boundary of a container element, and maps them to generic actions
 * which are specified using the custom jsaction attribute in
 * HTML. Behavior of the application is then specified in terms of
 * handler for such actions, cf. jsaction.Dispatcher in dispatcher.js.
 *
 * This has several benefits: (1) No DOM event handlers need to be
 * registered on the specific elements in the UI. (2) The set of
 * events that the application has to handle can be specified in terms
 * of the semantics of the application, rather than in terms of DOM
 * events. (3) Invocation of handlers can be delayed and handlers can
 * be delay loaded in a generic way.
 *
 * @constructor
 */
jsaction.EventContract = function() {
  /**
   * A list of functions. Each function will initialize a newly
   * registered contract for one event. See addContainer().
   *
   * @type {!Array.<!jsaction.ContainerInitializerFunction>}
   * @private
   */
  this.installers_ = [];

  /**
   * The containers signed up for this event contract. See addContainer().
   *
   * @type {!Array.<!jsaction.EventContractContainer>}
   * @private
   */
  this.containers_ = [];

  /**
   * The list of containers that are children of an existing container. If
   * STOP_PROPAGATION is false then we do not install event listeners on these
   * (since that would cause the event to be triggered more than once). We do
   * want to keep track of these containers such that we properly handle
   * additions/removals.
   * If STOP_PROPAGATION is true it is safe to add event listeners on all the
   * containers.
   * @type {!Array.<!jsaction.EventContractContainer>}
   * @private
   */
  this.nestedContainers_ = [];

  /**
   * The DOM events which this contract covers. Used to prevent double
   * registration of event types. The value of the map is the
   * internally created DOM event handler function that handles the
   * DOM events. See addEvent().
   *
   * @type {!Object.<string, !jsaction.EventHandlerFunction>}
   * @private
   */
  this.events_ = {};

  /**
   * The dispatcher function. Events are passed to this function for
   * handling once it was set using the dispatchTo() method. Usually
   * the dispatcher is the bound dispatch() method of a
   * jsaction.Dispatcher instance. This is done because the function
   * is passed from another jsbinary, so passing the instance and
   * invoking the method here would require to leave the method
   * unobfuscated.
   *
   * @type {?function((!jsaction.EventInfo|!Array.<!jsaction.EventInfo>),
   *                  boolean=)}
   * @private
   */
  this.dispatcher_ = null;

  /**
   * The queue of events. Events are queued while there is no
   * dispatcher set.
   * @type {Array.<!jsaction.EventInfo>}
   * @private
   */
  this.queue_ = [];

  if (jsaction.EventContract.CUSTOM_EVENT_SUPPORT) {
    this.addEvent(jsaction.EventType.CUSTOM);
  }
};


/**
 * @define {boolean} Controls the use of event.path logic for the dom
 * walking in createEventInfo_.
 */
goog.define('jsaction.EventContract.USE_EVENT_PATH', false);


/**
 * Whether the user agent is running on iOS.
 * @type {boolean}
 * @private
 */
jsaction.EventContract.isIos_ = typeof navigator != 'undefined' &&
    /iPhone|iPad|iPod/.test(navigator.userAgent);


/**
 * @define {boolean} Support for jsnamespace attribute.  This flag can be
 *     overriden in a build rule to trim down the EventContract's binary size.
 */
goog.define('jsaction.EventContract.JSNAMESPACE_SUPPORT', true);


/**
 * @define {boolean} Support for accessible click actions.  This flag can be
 *     overriden in a build rule.
 */
goog.define('jsaction.EventContract.A11Y_CLICK_SUPPORT', false);


/**
 * @define {boolean} Support for the non-bubbling mouseenter and mouseleave
 *     events.  This flag can be overridden in a build rule.
 */
goog.define('jsaction.EventContract.MOUSE_SPECIAL_SUPPORT', false);


/**
 * @define {boolean} Simulate click events based on touch events for browsers
 *     that have a 300ms delay before they send the click event. This is
 *     currently EXPERIMENTAL.
 */
goog.define('jsaction.EventContract.FAST_CLICK_SUPPORT', false);


/**
 * @define {boolean} Call stopPropagation on handled events. When integrating
 *      with non-jsaction event handler based code, you will likely want to turn
 *      this flag off. While most event handlers will continue to work, jsaction
 *      binds focus and blur events in the capture phase and thus with
 *      stopPropagation, none of your non-jsaction-handlers will ever see it.
 */
goog.define('jsaction.EventContract.STOP_PROPAGATION', true);


/**
 * @define {boolean} Support for custom events, which are type
 *      jsaction.EventType.CUSTOM. These are native DOM events with an
 *      additional type field and an optional payload.
 */
goog.define('jsaction.EventContract.CUSTOM_EVENT_SUPPORT', false);


/**
 * Specifies a click jsaction event type triggered by an Enter/Space DOM
 * keypress.
 * @private {string}
 * @const
 */
jsaction.EventContract.CLICKKEY_ = 'clickkey';


/**
 * Helper function to trim whitespace from the beginning and the end
 * of the string. This deliberately doesn't use the closure equivalent
 * to keep dependencies small.
 *
 * @param {string} str  Input string.
 * @return {string}  Trimmed string.
 * @private
 */
jsaction.EventContract.stringTrim_ = String.prototype.trim ?
    function(str) {
      return str.trim();
    } :
    function(str) {
      var trimmedLeft = str.replace(/^\s+/, '');
      return trimmedLeft.replace(/\s+$/, '');
    };


/**
 * This regular expression matches a semicolon.
 * @type {RegExp}
 * @private
 * @const
 */
jsaction.EventContract.REGEXP_SEMICOLON_ = /\s*;\s*/;


/**
 * The default event type.
 * @type {string}
 * @private
 */
jsaction.EventContract.defaultEventType_ = jsaction.EventType.CLICK;


/**
 * Information about an element that received a touchstart event
 * that we might want to translate into a click event once a touchend
 * event arrives.
 *
 * - node is the target element of the event.
 * - x and y are clientX and clientY of the event, respectively.
 *
 * The fields of this Object are unquoted.
 *
 * This object is reset when either touchend arrives within a short period of
 * time or when "fast click" is canceled due to touchmove or expiration. See
 * "resetFastClickNode_" method for more detail.
 *
 * @private {?{node: !Element, x: number, y: number}}
 */
jsaction.EventContract.fastClickNode_;


/**
 * The last emitted touchend event. It's used to ignore subsequent mouse
 * events when requested by "_preventMouseEvents".
 * @private {?Event}
 */
jsaction.EventContract.preventingMouseEvents_ = null;


/**
 * A timer that we schedule after a touchstart. If the timer fires before the
 * touchend event, the press is considered a long-press that does not get
 * translated into a click.
 * @private {number}
 */
jsaction.EventContract.fastClickTimeout_;


/**
 * Gets the default event type.
 * @return {string} The default event type.
 */
jsaction.EventContract.getDefaultEventType = function() {
  return jsaction.EventContract.defaultEventType_;
};


/**
 * Sets a new default event type.
 * @param {string} eventType The new default event type.
 */
jsaction.EventContract.setDefaultEventType = function(eventType) {
  jsaction.EventContract.defaultEventType_ = eventType;
};


/**
 * Returns a function that handles events on a container and invokes a local
 * event handler (bound using the actions map) on the source node or any of
 * its ancestors up to the container to which the returned event handler
 * belongs. The local event handler is passed an ActionFlow which allows
 * access to the node, event, and values defined on the node. If there are no
 * jsaction handlers bound that can handle this event, the flow representing
 * the event is stored in a queue for replaying at a later time.
 *
 * @param {!jsaction.EventContract} eventContract The EventContract
 *     instance to create this handler for.
 * @param {string} eventType The type of the event - e.g. 'click'.
 *     Note that event.type can differ from eventType. In some browsers (e.g.
 *     Firefox) the event handling code registers handlers for 'focusin' and
 *     'focusout' to handle 'focus' and 'blur' respectively. In those cases,
 *     event.type might be 'focus', but eventType will be 'focusin'.
 * @return {jsaction.EventHandlerFunction} The DOM event handler to
 *     use for the given event type on all containers.
 * @private
 */
jsaction.EventContract.eventHandler_ = function(eventContract, eventType) {
  /**
   * See description above.
   * @param {!Event} e Event.
   * @this {!Element}
   */
  var handler = function(e) {
    var container = this;
    // Store eventType's value in a local variable so that multiple calls do not
    // modify the shared eventType variable.
    var eventTypeForDispatch = eventType;
    if (jsaction.EventContract.CUSTOM_EVENT_SUPPORT &&
        eventTypeForDispatch == jsaction.EventType.CUSTOM) {
      var detail = e['detail'];
      // For custom events, use a secondary dispatch based on the internal
      // custom type of the event.
      if (!detail || !detail['_type']) {
        // This should never happen.
        return;
      }
      eventTypeForDispatch = detail['_type'];
    }

    var eventInfo = jsaction.EventContract.createEventInfo_(
        eventTypeForDispatch, e, container);

    if (eventContract.dispatcher_) {
      var globalEventInfo = jsaction.EventContract.createEventInfoInternal_(
          eventInfo['eventType'], eventInfo['event'],
          eventInfo['targetElement'], eventInfo['action'],
          eventInfo['actionElement'], eventInfo['timeStamp']);

      // In some cases, createEventInfo_() will rewrite click events to
      // clickonly.  Revert back to a regular click, otherwise we won't be able
      // to execute global event handlers registered on click events.
      if (globalEventInfo['eventType'] == jsaction.EventType.CLICKONLY) {
        globalEventInfo['eventType'] = jsaction.EventType.CLICK;
      }

      eventContract.dispatcher_(
          globalEventInfo, /* dispatch global event */ true);
    }

    // Return early if no action element found while walking up the DOM tree.
    if (!eventInfo['actionElement']) {
      return;
    }

    if (jsaction.EventContract.STOP_PROPAGATION) {
      if (jsaction.event.isGecko &&
          (eventInfo['targetElement'].tagName == goog.dom.TagName.INPUT ||
            eventInfo['targetElement'].tagName == goog.dom.TagName.TEXTAREA) &&
          (eventInfo['eventType'] == jsaction.EventType.FOCUS)) {
        // Do nothing since stopping propagation a focus event on an input
        // element in Firefox makes the text cursor disappear:
        // https://bugzilla.mozilla.org/show_bug.cgi?id=509684
      } else {
        // Since we found a jsaction, prevent other handlers from seeing
        // this event.
        jsaction.event.stopPropagation(e);
      }
    }

    // Prevent browser from following <a> node links if a jsaction is
    // present. Note that the targetElement may be a child of an anchor that has
    // a jsaction attached. For that reason, we need to check the actionElement
    // rather than the targetElement.
    if (eventInfo['actionElement'].tagName == goog.dom.TagName.A &&
        (eventInfo['eventType'] == jsaction.EventType.CLICK ||
            eventInfo['eventType'] == jsaction.EventType.CLICKMOD)) {
      jsaction.event.preventDefault(e);
    }

    if (eventContract.dispatcher_) {
      eventContract.dispatcher_(eventInfo);
    } else {
      var copiedEvent = jsaction.event.maybeCopyEvent(e);
      // The event is queued since there is no dispatcher registered
      // yet. Potentially make a copy of the event in order to extend its
      // life. The copy will later be used when attempting to replay.
      eventInfo['event'] = copiedEvent;
      eventContract.queue_.push(eventInfo);
    }

    jsaction.EventContract.afterEventHandler_(eventInfo);
  };
  return handler;
};


/**
 * Post-processes event. Called after event has been sent to the handler.
 * @param {!jsaction.EventInfo} eventInfo
 * @private
 */
jsaction.EventContract.afterEventHandler_ = function(eventInfo) {
  // Setup sweeper if mouse events have been canceled.
  if (eventInfo.event.type == jsaction.EventType.TOUCHEND &&
     jsaction.event.isMouseEventsPrevented(eventInfo.event)) {
    jsaction.EventContract.preventingMouseEvents_ = /** @type {!Event} */ (
        jsaction.event.recreateTouchEventAsClick(eventInfo.event));
  }
};


/**
 * Searches for a jsaction that the DOM event maps to and creates an
 * object containing event information used for dispatching by
 * jsaction.Dispatcher. The dispatch information returned consists of
 * the event type, target element, action and the Event instance
 * supplied by the DOM. The jsaction for the DOM event is the first
 * jsaction attribute above the target Node of the event, and below
 * the container Node, that specifies a jsaction for the event
 * type. If no such jsaction is found, the actionElement properties is null.
 *
 * @param {string} eventType The type of the event, e.g. 'click', as
 *     specified by event contract. This may differ from the DOM event
 *     type, because event contract may use more generic event types.
 * @param {!Event} e The Event instance received by the container from
 *     the DOM.
 * @param {!Node} container The container which limits the search for
 *     jsactions which can handle the event.
 * @return {jsaction.EventInfo} The event info object.  If its actionElement
 *     property is null, no jsaction was found above the target Node of the
 *     event.
 * @private
 */
jsaction.EventContract.createEventInfo_ = function(eventType, e, container) {
  // We distinguish modified and plain clicks in order to support the
  // default browser behavior of modified clicks on links; usually to
  // open the URL of the link in new tab or new window on ctrl/cmd
  // click. A DOM 'click' event is mapped to the jsaction 'click'
  // event iff there is no modifier present on the event. If there is
  // a modifier, it's mapped to 'clickmod' instead.
  //
  // It's allowed to omit the event in the jsaction attribute. In that
  // case, 'click' is assumed. Thus the following two are equivalent:
  //
  //   <a href="someurl" jsaction="gna.fu">
  //   <a href="someurl" jsaction="click:gna.fu">
  //
  // For unmodified clicks, EventContract invokes the jsaction
  // 'gna.fu'. For modified clicks, EventContract won't find a
  // suitable action and and leave the event to be handled by the
  // browser.
  //
  // In order to also invoke a jsaction handler for a modifier click,
  // 'clickmod' needs to be used:
  //
  //   <a href="someurl" jsaction="clickmod:gna.fu">
  //
  // EventContract invokes the jsaction 'gna.fu' for modified
  // clicks. Unmodified clicks are left to the browser.
  //
  // In order to set up the event contract to handle both clickonly and
  // clickmod, only addEvent(jsaction.EventType.CLICK) is necessary.
  //
  // In order to set up the event contract to handle click,
  // addEvent() is necessary for CLICK, KEYDOWN, and KEYPRESS event types.  If
  // the jsaction.EventContract.A11Y_CLICK_SUPPORT flag is turned on, addEvent()
  // will set up the appropriate key event handler automatically.
  if (eventType == jsaction.EventType.CLICK &&
      jsaction.event.isModifiedClickEvent(e)) {
    eventType = jsaction.EventType.CLICKMOD;
  } else if (jsaction.EventContract.A11Y_CLICK_SUPPORT &&
             jsaction.event.isActionKeyEvent(e)) {
    eventType = jsaction.EventContract.CLICKKEY_;
  }

  var target = /** @type {!Element} */(e.srcElement || e.target);
  var eventInfo = jsaction.EventContract.createEventInfoInternal_(
      eventType, e, target, '', null);

  // NOTE(user): In order to avoid complicating the code that calculates the
  // event's path, we need a common interface to iterating over event.path or
  // walking the DOM.  We use the generator pattern here, as generating the
  // path array ahead of time for DOM walks will result in degraded
  // performance.

  /** @type {jsaction.ActionInfo} */
  var actionInfo;
  // NOTE(user): This is a work around some issues with custom dispatchers.
  var element;
  if (jsaction.EventContract.USE_EVENT_PATH) {
    var generator = jsaction.domGenerator.getGenerator(
        e, target, /** @type {!Element} */(container));
    for (var node; node = generator.next();) {
      element = node;
      actionInfo = jsaction.EventContract.getAction_(
          element, eventType, e, container);
      eventInfo = jsaction.EventContract.createEventInfoInternal_(
          actionInfo.eventType, actionInfo.event || e, target,
          actionInfo.action || '', element,
          eventInfo['timeStamp']);

      // TODO(user): If we can get rid of the break on actionInfo.ignore
      // these loops can collapse down to one and the contents can live in
      // a function.
      // Stop walking the DOM prematurely if we will ignore this event.  This is
      // used solely for fastbutton's implementation.
      if (actionInfo.ignore ||
          // An event is handled by at most one jsaction. Thus we stop at
          // the first matching jsaction specified in a jsaction attribute
          // up the ancestor chain of the event target node.
          actionInfo.action) {
        break;
      }
    }
  } else {
    for (var node = target; node && node != container;
      // Walk to the parent node, unless the node has a different owner in
      // which case we walk to the owner.
      node = node[jsaction.Property.OWNER] || node.parentNode) {
      element = node;
      actionInfo = jsaction.EventContract.getAction_(
          element, eventType, e, container);

      // Stop walking the DOM prematurely if we will ignore this event.  This is
      // used solely for fastbutton's implementation.
      if (actionInfo.ignore ||
          // An event is handled by at most one jsaction. Thus we stop at
          // the first matching jsaction specified in a jsaction attribute
          // up the ancestor chain of the event target node.
          actionInfo.action) {
        break;
      }
    }
    if (actionInfo) {
      eventInfo = jsaction.EventContract.createEventInfoInternal_(
          actionInfo.eventType, actionInfo.event || e, target,
          actionInfo.action || '', element,
          eventInfo['timeStamp']);
    }
  }

  // A touchend is "enhanced" to support mouse-events canceling.
  if (eventInfo && eventInfo['eventType'] == jsaction.EventType.TOUCHEND) {
    jsaction.event.addPreventMouseEventsSupport(eventInfo['event']);
  }

  if (actionInfo && actionInfo.action) {
    // Prevent scrolling if the Space key was pressed and prevent the browser's
    // default action for native HTML controls.
    if (jsaction.EventContract.A11Y_CLICK_SUPPORT &&
        eventType == jsaction.EventContract.CLICKKEY_ &&
        (jsaction.event.isSpaceKeyEvent(e) ||
         jsaction.event.shouldCallPreventDefaultOnNativeHtmlControl(e))) {
      jsaction.event.preventDefault(e);
    }

    // We attempt to handle the mouseenter/mouseleave events here by
    // detecting whether the mouseover/mouseout events correspond to
    // entering/leaving an element.
    if (jsaction.EventContract.MOUSE_SPECIAL_SUPPORT &&
        (eventType == jsaction.EventType.MOUSEENTER ||
         eventType == jsaction.EventType.MOUSELEAVE)) {
      // We attempt to handle the mouseenter/mouseleave events here by
      // detecting whether the mouseover/mouseout events correspond to
      // entering/leaving an element.
      if (jsaction.event.isMouseSpecialEvent(e, eventType, element)) {
        // If both mouseover/mouseout and mouseenter/mouseleave events are
        // enabled, two separate handlers for mouseover/mouseout are
        // registered. Both handlers will see the same event instance
        // so we create a copy to avoid interfering with the dispatching of
        // the mouseover/mouseout event.
        var copiedEvent = jsaction.event.createMouseSpecialEvent(
            e, /** @type {!Element} */ (element));
        eventInfo['event'] = /** @type {!Event} */ (copiedEvent);
        // Since the mouseenter/mouseleave events do not bubble, the target
        // of the event is technically the node on which the jsaction is
        // specified (the actionElement).
        eventInfo['targetElement'] = element;
      } else {
        eventInfo['action'] = '';
        eventInfo['actionElement'] = null;
      }
    }
    return eventInfo;
  }
  // Reset action-related properties of the current eventInfo, to ensure we
  // won't dispatch a non-existing action.
  eventInfo['action'] = '';
  eventInfo['actionElement'] = null;
  return eventInfo;
};


/**
 * @param {string} eventType
 * @param {!Event} e
 * @param {!Element} targetElement
 * @param {string} action
 * @param {Element} actionElement
 * @param {number=} opt_timeStamp
 * @return {jsaction.EventInfo}
 * @private
 */
jsaction.EventContract.createEventInfoInternal_ = function(
    eventType, e, targetElement, action, actionElement, opt_timeStamp) {
  // Event#timeStamp is broken on Firefox for synthetic events.  See
  // https://bugzilla.mozilla.org/show_bug.cgi?id=238041 for details.  Since
  // Firefox marks Event#timeStamp as read-only, the only workaround is to
  // expose a timestamp directly in eventInfo, to be consistent across all
  // browsers.
  return /** @type {jsaction.EventInfo} */ ({
    'eventType': eventType,
    'event': e,
    'targetElement': targetElement,
    'action': action,
    'actionElement': actionElement,
    'timeStamp': opt_timeStamp || goog.now()
  });
};


/**
 * Accesses the event handler attribute value of a DOM node. It guards
 * against weird situations (described in the body) that occur in
 * connection with nodes that are removed from their document.
 * @param {!Element} node The DOM node.
 * @param {string} attribute The name of the attribute to access.
 * @return {?string} The attribute value if it was found, null
 *     otherwise.
 * @private
 */
jsaction.EventContract.getAttr_ = function(node, attribute) {
  var value = null;
  // NOTE(user): Nodes in IE do not always have a getAttribute
  // method defined. This is the case where sourceElement has in
  // fact been removed from the DOM before eventContract begins
  // handling - where a parentNode does not have getAttribute
  // defined.
  // NOTE(ruilopes): We must use the 'in' operator instead of the regular dot
  // notation, since the latter fails in IE8 if the getAttribute method is not
  // defined. See b/7139109.
  if ('getAttribute' in node) {
    value = node.getAttribute(attribute);
  }
  return value;
};


/**
 * Since maps from event to action are immutable we can use a single map
 * to represent the empty map.
 * @private @const {!Object.<string, string>}
 */
jsaction.EventContract.EMPTY_ACTION_MAP_ = {};


/**
 * Accesses the jsaction map on a node and retrieves the name of the
 * action the given event is mapped to, if any. It parses the
 * attribute value and stores it in a property on the node for
 * subsequent retrieval without re-parsing and re-accessing the
 * attribute. In order to fully qualify jsaction names using a
 * namespace, the DOM is searched starting at the current node and
 * going through ancestor nodes until a jsnamespace attribute is
 * found.
 *
 * @param {!Element} node The DOM node to retrieve the jsaction map
 *     from.
 * @param {string} eventType The type of the event for which to
 *     retrieve the action.
 * @param {!Event} event The current browser event.
 * @param {!Node} container The node which limits the namespace lookup
 *     for a jsaction name. The container node itself will not be
 *     searched.
 * @return {jsaction.ActionInfo} The action info.
 * @private
 */
jsaction.EventContract.getAction_ = function(node, eventType, event,
    container) {
  var actionMap = jsaction.Cache.get(node);
  if (!actionMap) {
    var attvalue = jsaction.EventContract.getAttr_(
        node, jsaction.Attribute.JSACTION);
    if (!attvalue) {
      actionMap = jsaction.EventContract.EMPTY_ACTION_MAP_;
      jsaction.Cache.set(node, actionMap);
    } else {
      actionMap = jsaction.Cache.getParsed(attvalue);
      if (!actionMap) {
        actionMap = {};
        var values = attvalue.split(jsaction.EventContract.REGEXP_SEMICOLON_);
        for (var i = 0, I = values ? values.length : 0; i < I; i++) {
          var value = values[i];
          if (!value) {
            continue;
          }
          var colon = value.indexOf(jsaction.Char.EVENT_ACTION_SEPARATOR);
          var hasColon = colon != -1;
          var type = hasColon ?
              jsaction.EventContract.stringTrim_(value.substr(0, colon)) :
              jsaction.EventContract.defaultEventType_;
          var action = hasColon ? jsaction.EventContract.stringTrim_(
              value.substr(colon + 1)) : value;
          actionMap[type] = action;
        }
        jsaction.Cache.setParsed(attvalue, actionMap);
      }
      // If namespace support is active we need to augment the (potentially
      // cached) jsaction mapping with the namespace.
      if (jsaction.EventContract.JSNAMESPACE_SUPPORT) {
        var noNs = actionMap;
        actionMap = {};
        for (var type in noNs) {
          actionMap[type] = jsaction.EventContract.getQualifiedName_(
              noNs[type], node, container);
        }
      }
      jsaction.Cache.set(node, actionMap);
    }
  }

  if (jsaction.EventContract.A11Y_CLICK_SUPPORT) {
    if (eventType == jsaction.EventContract.CLICKKEY_) {
      // A 'click' triggered by a DOM keypress should be mapped to the 'click'
      // jsaction.
      eventType = jsaction.EventType.CLICK;
    } else if (eventType == jsaction.EventType.CLICK &&
        !actionMap[jsaction.EventType.CLICK]) {
      // A 'click' triggered by a DOM click should be mapped to the 'click'
      // jsaction, if available, or else fallback to the 'clickonly' jsaction.
      // If 'click' and 'clickonly' jsactions are used together, 'click' will
      // prevail.
      eventType = jsaction.EventType.CLICKONLY;
    }
  }

  var overrideEvent = null;
  if (jsaction.EventContract.FAST_CLICK_SUPPORT &&
      // Don't want fast click behavior? Just bind clickonly instead.
      actionMap[jsaction.EventType.CLICK]) {
    var fastEvent = jsaction.EventContract.getFastClickEvent_(node,
        event, actionMap);
    if (!fastEvent) {
      // Null means to stop looking for further events, as the logic event
      // has already been handled or the event started a sequence that may
      // eventually lead to a logic click event.
      return {
        eventType: eventType,
        action: '',
        event: null,
        ignore: true
      };
    } else if (fastEvent != event) {
      overrideEvent = fastEvent;
      eventType = fastEvent.type;
    }
  }

  // An empty action indicates that no jsaction attribute was found in the given
  // DOM node.
  var actionName = actionMap[eventType] || '';

  return {
    eventType: eventType,
    action: actionName,
    event: overrideEvent,
    ignore: false
  };
};


/**
 * Returns the qualified jsaction name, i.e. the name of the jsaction
 * including the namespace part before the dot. If the given jsaction
 * name doesn't already contain the namespace, the function iterates
 * over ancestor nodes until a jsnamespace attribute is found, and
 * uses the value of that attribute as the namespace.
 *
 * @param {string} name The jsaction name to resolve the namespace of.
 * @param {Element} start The node from which to start searching for a
 *     jsnamespace attribute.
 * @param {Node} container The node which limits the search for a
 *     jsnamespace attribute. This node will be searched.
 * @return {string} The qualified name of the jsaction. If no
 *     namespace is found, returns the unqualified name in case it
 *     exists in the global namespace.
 * @private
 */
jsaction.EventContract.getQualifiedName_ = function(name, start, container) {
  if (jsaction.EventContract.JSNAMESPACE_SUPPORT) {
    if (jsaction.EventContract.isQualifiedName_(name)) {
      return name;
    }

    for (var node = start; node; node = node.parentNode) {
      var ns = jsaction.EventContract.getNamespace_(
          /** @type {!Element} */(node));
      if (ns) {
        return ns + jsaction.Char.NAMESPACE_ACTION_SEPARATOR + name;
      }

      // If this node is the container, stop.
      if (node == container) {
        break;
      }
    }
  }

  return name;
};


/**
 * Converts a sequence of touchstart and touchend events into a click event
 * and ignores a subsequent click event (within 400ms).
 *
 * This method returns the original or a synthesized event instance, or null if
 * the event should be ignored. The original event indicates that the original
 * event should proceed as planned. If the event should be ignored (e.g. to
 * issue a new event later), the returned value is null. However, if the
 * "fast click" event is determined, a newly synthesized event instance is
 * returned. The "click" event has to be synthesized to imitate an actual
 * "click" event based on "touchend". This includes filling in type, target,
 * clientX/Y, etc, which are expected from a "click" event. The original Event
 * instance cannot simply be modified, because the DOM Event Spec defines Event
 * properties to be immutable, and some browsers (specifically Safari in iOS/8)
 * enforce this.
 *
 * @param {!Element} node The current node with a jsaction annotation.
 * @param {!Event} event The current browser event.
 * @param {!Object.<string, string>} actionMap
 * @return {Event}
 * @private
 */
jsaction.EventContract.getFastClickEvent_ = function(node, event, actionMap) {
  if (event.type == jsaction.EventType.CLICK) {
    return event;
  }
  if (event.targetTouches && event.targetTouches.length > 1) {
    // Click emulation does not make sense for multi touch.
    return event;
  }

  var fastClickNode = jsaction.EventContract.fastClickNode_;
  var target = event.target;
  if (target) {
    // Don't do anything special for clicks on elements with elaborate built in
    // click and focus behavior.
    if (jsaction.EventContract.isInput_(target)) {
      return event;
    }
  }

  var touch = jsaction.event.getTouchData(event);

  // When a touchstart is fired, remember the action node in a global variable.
  // When a subsequent touchend arrives, it'll be interpreted as a click.
  if (event.type == jsaction.EventType.TOUCHSTART &&
      // If the jsaction binds touchstart or touchend explicitly, we don't do
      // anything special with it.
      !actionMap[jsaction.EventType.TOUCHSTART] &&
      !actionMap[jsaction.EventType.TOUCHEND]) {
    jsaction.EventContract.fastClickNode_ = {
            node: node,
            x: touch ? touch.clientX : 0,
            y: touch ? touch.clientY : 0};
    jsaction.EventContract.preventingMouseEvents_ = null;
    clearTimeout(jsaction.EventContract.fastClickTimeout_);

    // If touchend doesn't arrive within a reasonable amount of time, this is
    // a long click and not a click, so we throw away and will ignore
    // a later touchend.
    jsaction.EventContract.fastClickTimeout_ = setTimeout(
        jsaction.EventContract.resetFastClickNode_, 400);
    return null;
  }

  // If a touchend was fired on what had a previous touchstart, count the event
  // as a click.
  else if (event.type == jsaction.EventType.TOUCHEND &&
              fastClickNode && fastClickNode.node == node) {
    // If the touchend is more than 4px Manhattan away from the touchstart event
    // don't consider this a click even when on the same element. This is
    // necessary when dragging an element and mousemove events are cancelled.
    if (!event.defaultPrevented &&
        !(touch && (Math.abs(touch.clientX - fastClickNode.x) +
            Math.abs(touch.clientY - fastClickNode.y)) > 4)) {
      var newEvent = /** @type {!Event} */ (jsaction.event.
              recreateTouchEventAsClick(event));
      jsaction.EventContract.preventingMouseEvents_ = newEvent;

      // Cancel "touchend" and send the emulated "click" event.
      event.stopPropagation();
      event.preventDefault();
      var clickEvent = jsaction.createMouseEvent(newEvent);
      clickEvent['_fastclick'] = true;
      newEvent.target.dispatchEvent(clickEvent);
      if (!clickEvent.defaultPrevented) {
        // Remove the virtual keyboard since it's the default "touchend"
        // behavior that we cancelled above.
        if (document.activeElement &&
                document.activeElement != clickEvent.target &&
                jsaction.EventContract.isInput_(document.activeElement)) {
          try {
            document.activeElement.blur();
          } catch (e) {
            // ignore
          }
        }
        // Reset selection as well. This normally done on "mousedown", but
        // we cancel mouse events.
        try {
          window.getSelection().removeAllRanges();
        } catch (e) {
          // ignore
        }
      }
      return null;
    } else {
      jsaction.EventContract.resetFastClickNode_();
    }
  }

  // Touchmove is fired when the user scrolls. In this case a previous
  // touchstart is ignored.
  else if (event.type == jsaction.EventType.TOUCHMOVE && fastClickNode) {
    // Ignore jitters: iOS often sends +/- 2px touchmove events. Thus we will
    // ignore any moves with the Manhattan distance 4 pixels or less.
    if (touch && (Math.abs(touch.clientX - fastClickNode.x) +
            Math.abs(touch.clientY - fastClickNode.y)) > 4) {
      jsaction.EventContract.resetFastClickNode_();
    }
  }
  return event;
};


/**
 * Returns true if the specified element is an input.
 * @param {!EventTarget} target
 * @return {boolean}
 * @private
 */
jsaction.EventContract.isInput_ = function(target) {
  var tagName = target.tagName || '';
  return (tagName == 'TEXTAREA' || tagName == 'INPUT' || tagName == 'SELECT' ||
      tagName == 'OPTION');
};


/**
 * Cancels the expectation that there might come a touchend to after a
 * touchstart, so we can synthesize a click.
 * @private
 */
jsaction.EventContract.resetFastClickNode_ = function() {
  jsaction.EventContract.fastClickNode_ = null;
};


/**
 * On mobile browsers, touchend is typically followed by an emulated sequence of
 * mouse events. In "fastclick" emulation and similar use cases these events are
 * no longer necessary and could lead to duplicate event processing. Instead,
 * the handler can instruct to cancel mouse events following "touchend" event by
 * using the "_preventMouseEvents" method.
 * @param {!Event} event
 * @private
 */
jsaction.EventContract.sweepupPreventedMouseEvents_ = function(event) {
  if (event['_fastclick']) {
    // It's the "fastclick" we issued - proceed uninterrupted.
    return;
  }

  var fastClickEvent = jsaction.EventContract.preventingMouseEvents_;
  if (!fastClickEvent) {
    // No recent "fastclick" - proceed uninterrupted.
    return;
  }

  // The mouse event has to arrive for a previously issued "fastclick" event
  // within a short period of time, 800 milliseconds in this case. This value
  // comes from the fact that after TOUCHEND iOS Safari typically issues
  // MOUSEENTER, MOUSEOVER, MOUSEMOVE, MOUSEDOWN, MOUSEUP and finally CLICK
  // event. The tests show that iOS issues these events one at a time with
  // about 50-60 milliseconds in between, which sums up to about ~350-400
  // milliseconds.
  //
  // Tests on Firefox 32 have shown up to 800+ milliseconds from TOUCHEND to the
  // final CLICK event being emitted.
  //
  // Increasing this value is benign. It will not prevent double clicks since
  // any subsequent TOUCHSTART will cancel this sweep.
  if (goog.now() - fastClickEvent.timeStamp > 800) {
    jsaction.EventContract.preventingMouseEvents_ = null;
    return;
  }

  // The simplest case is when the target of both events is the same. However,
  // it's not always the case, as when the content is scrolled or when
  // overlays are shown quickly after click. In the latter case, we have to
  // measure the distance between the events.
  var isSameTarget = fastClickEvent.target == event.target;

  // Similar to "touchend" sometimes there can be a drift of the click event.
  // In tests it never was more than 2px in either direction, thus we
  // check for 4px Manhattan distance.
  var isNear = (Math.abs(event.clientX - fastClickEvent.clientX) +
      Math.abs(event.clientY - fastClickEvent.clientY)) <= 4;

  // If neither condition is true all mouse-events canceling for all subsequent
  // mouse events is canceled.
  if (!isSameTarget && !isNear) {
    jsaction.EventContract.preventingMouseEvents_ = null;
    return;
  }

  // We stop propagation and cancel event to avoid elements receiving the
  // event twice.
  event.stopPropagation();
  event.preventDefault();

  // No mouse events expected after click - stop monitoring.
  if (event.type == jsaction.EventType.CLICK) {
    jsaction.EventContract.preventingMouseEvents_ = null;
  }
};


if (jsaction.EventContract.JSNAMESPACE_SUPPORT) {
  /**
   * Checks if a jsaction name contains a namespace part.
   * @param {string} name The name of a jsaction.
   * @return {boolean} Whether the name contains a namespace part.
   * @private
   */
  jsaction.EventContract.isQualifiedName_ = function(name) {
    return name.indexOf(jsaction.Char.NAMESPACE_ACTION_SEPARATOR) >= 0;
  };


  /**
   * Returns the value of the jsnamespace attribute of the given node.
   * Also caches the value for subsequent lookups.
   * @param {!Element} node The node whose jsnamespace attribute is being
   *     asked for.
   * @return {?string} The value of the jsnamespace attribute, or null if not
   *     found.
   * @private
   */
  jsaction.EventContract.getNamespace_ = function(node) {
    var jsnamespace = jsaction.Cache.getNamespace(node);
    // Only query for the attribute if it has not been queried for
    // before. jsaction.EventContract.getAttr_() returns null if an
    // attribute is not present. Thus, jsnamespace is string|null if
    // the query took place in the past, or undefined if the query did
    // not take place.
    if (!goog.isDef(jsnamespace)) {
      jsnamespace =
          jsaction.EventContract.getAttr_(node, jsaction.Attribute.JSNAMESPACE);
      jsaction.Cache.setNamespace(node, jsnamespace);
    }
    return jsnamespace;
  };
}


/**
 * Factory for container installer functions. The returned function
 * will install the given handler for the event given by name here on
 * the container passed to the returned function. It is used to
 * register all currently known events on a newly registered
 * container.
 *
 * @param {string} name The name of the event.
 * @param {jsaction.EventHandlerFunction} handler An event handler.
 * @return {jsaction.ContainerInitializerFunction} A function that, when
 *     applied to an Element, installs the given event handler for the
 *     event type given by name.
 * @private
 */
jsaction.EventContract.containerHandlerInstaller_ = function(name, handler) {
  /**
   * @param {!Element} div The container to install this handler on.
   * @return {jsaction.EventHandlerInfo} The event name and the
   *    handler installed by the function.
   */
  var installer = function(div) {
    return jsaction.event.addEventListener(div, name, handler);
  };
  return installer;
};


/**
 * Enables jsaction handlers to be called for the event type given by
 * name.
 *
 * If the event is already registered, this does nothing.
 *
 * @param {string} name Event name.
 * @param {string=} opt_prefixedName If supplied, this event is used in
 *     the actual browser event registration instead of the name that is
 *     exposed to jsaction. Use this if you e.g. want users to be able
 *     to subscribe to jsaction="transitionEnd:foo" while the underlying
 *     event is webkitTransitionEnd in one browser and mozTransitionEnd
 *     in another.
 */
jsaction.EventContract.prototype.addEvent = function(name, opt_prefixedName) {
  if (this.events_.hasOwnProperty(name)) {
    return;
  }

  if (!jsaction.EventContract.MOUSE_SPECIAL_SUPPORT &&
      (name == jsaction.EventType.MOUSEENTER ||
       name == jsaction.EventType.MOUSELEAVE)) {
    return;
  }

  var handler = jsaction.EventContract.eventHandler_(this, name);

  // Install the callback which handles events on the container.
  var installer = jsaction.EventContract.containerHandlerInstaller_(
      opt_prefixedName || name, handler);

  // Store the callback to allow us to replay events.
  this.events_[name] = handler;

  this.installers_.push(installer);
  for (var i = 0; i < this.containers_.length; ++i) {
    this.containers_[i].installHandler(installer);
  }

  // Automatically install a keypress/keydown event handler if support for
  // accessible clicks is turned on.
  if (jsaction.EventContract.A11Y_CLICK_SUPPORT &&
      name == jsaction.EventType.CLICK) {
    this.addEvent(jsaction.EventType.KEYDOWN);
  }

  if (jsaction.EventContract.FAST_CLICK_SUPPORT &&
      name == jsaction.EventType.CLICK) {
    this.initializeFastClick_();
  }
};


/**
 * Add events needed for fast-click support.
 * @private
 */
jsaction.EventContract.prototype.initializeFastClick_ = function() {
  this.addEvent(jsaction.EventType.TOUCHSTART);
  this.addEvent(jsaction.EventType.TOUCHEND);
  this.addEvent(jsaction.EventType.TOUCHMOVE);
  // We need to capture CLICK events to cancel clicks that were already
  // issued based on TOUCHEND. The only reason for this handler is to work
  // around an issue with iOS Safari where a CLICK event sometimes is issued
  // even though the TOUCHEND has been canceled.
  // This is ignored on IE8 which doesn't have touch support.
  if (document.addEventListener) {
    document.addEventListener(jsaction.EventType.CLICK,
        jsaction.EventContract.sweepupPreventedMouseEvents_, true);
    document.addEventListener(jsaction.EventType.MOUSEUP,
        jsaction.EventContract.sweepupPreventedMouseEvents_, true);
    document.addEventListener(jsaction.EventType.MOUSEDOWN,
        jsaction.EventContract.sweepupPreventedMouseEvents_, true);
  }
};


/**
 * Returns the event handler function for a given event type.
 * @param {string} name Event name.
 * @return {jsaction.EventHandlerFunction|undefined} The event handler
 *     function or undefined if it does not exist.
 */
jsaction.EventContract.prototype.handler = function(name) {
  return this.events_[name];
};


/**
 * Signs the event contract for a new container. All registered events
 * are enabled for this container too. Containers have to be kept disjoint,
 * so if the newly added container is a parent/child of existing containers,
 * they will be merged.
 *
 * The caller of addContainer can keep a reference to this if it desires
 * to remove the container later.
 *
 * @param {!Element} div The container element. Usually a DIV, but not
 *     constrained to.
 * @return {!jsaction.EventContractContainer} The container object that was
 *     created.
 */
jsaction.EventContract.prototype.addContainer = function(div) {
  var container = new jsaction.EventContractContainer(div);
  if (!jsaction.EventContract.STOP_PROPAGATION) {
    if (this.hasContainerFor_(div)) {
      // This container has an ancestor that is already a contract container.
      // Don't install event listeners on it when STOP_PROPAGATION is false
      // in order to prevent an event from being handled multiple times. We
      // still want to keep track of it in order to be able to correctly
      // add/remove containers.
      this.nestedContainers_.push(container);
      return container;
    }
    this.setUpContainer_(container);
    this.containers_.push(container);
    this.updateNestedContainers_();
  } else {
    this.setUpContainer_(container);
    this.containers_.push(container);
  }

  return container;
};


/**
 * Updates the list of nested containers after an add/remove operation. Only
 * containers that are not children of other containers are placed in the
 * containers list (and have event listeners on them). This is done in order to
 * prevent events from being handled multiple times when STOP_PROPAGATION is
 * false.
 * @private
 */
jsaction.EventContract.prototype.updateNestedContainers_ = function() {
  var allContainers = this.nestedContainers_.concat(this.containers_);
  var newNestedContainers = [];
  var newContainers = [];

  for (var i = 0; i < this.containers_.length; ++i) {
    var container = this.containers_[i];
    if (jsaction.EventContractContainer.isNested_(container, allContainers)) {
      newNestedContainers.push(container);
      // Remove the event listeners from the nested container.
      container.cleanUp();
    } else {
      newContainers.push(container);
    }
  }

  for (var i = 0; i < this.nestedContainers_.length; ++i) {
    var container = this.nestedContainers_[i];
    if (jsaction.EventContractContainer.isNested_(container, allContainers)) {
      newNestedContainers.push(container);
    } else {
      newContainers.push(container);
      // The container is no longer nested, add event listeners on it.
      this.setUpContainer_(container);
    }
  }

  this.containers_ = newContainers;
  this.nestedContainers_ = newNestedContainers;
};


/**
 * Adds the event listeners on the new container.
 * @param {!jsaction.EventContractContainer} container The newly added
 *     container.
 * @private
 */
jsaction.EventContract.prototype.setUpContainer_ = function(container) {
  var div = container.div;

  // In iOS, event bubbling doesn't happen automatically in any DOM element,
  // unless it has an onclick attribute or DOM event handler attached to it.
  // This breaks JsAction in some cases. See "Making Elements Clickable" section
  // at http://goo.gl/2VoGnB.
  //
  // A workaround for this issue is to change the CSS cursor style to 'pointer'
  // for the container element, which magically turns on event bubbling. This
  // solution is described in the comments section at http://goo.gl/6pEO1z.
  //
  // We use a navigator.userAgent check here as this problem is present both on
  // Mobile Safari and thin WebKit wrappers, such as Chrome for iOS.
  if (jsaction.EventContract.isIos_) {
    div.style.cursor = 'pointer';
  }

  for (var i = 0; i < this.installers_.length; ++i) {
    container.installHandler(this.installers_[i]);
  }
};


/**
 * Tests whether this EventContract already has a container that is a parent of
 * the div sent as a parameter.
 * @param {Element} div The element for which we need to test if there already
 *     is a container for it.
 * @return {boolean} True if there already is such a registered container,
 *     false otherwise.
 * @private
 */
jsaction.EventContract.prototype.hasContainerFor_ = function(div) {
  for (var i = 0; i < this.containers_.length; i++) {
    if (this.containers_[i].containsNode(div)) {
      return true;
    }
  }
  return false;
};


/**
 * Removes an already-added container from the contract.
 *
 * @param {jsaction.EventContractContainer} container The container object to
 *     remove.
 */
jsaction.EventContract.prototype.removeContainer = function(container) {
  container.cleanUp();
  var removed = false;
  for (var i = 0; i < this.containers_.length; ++i) {
    if (this.containers_[i] === container) {
      this.containers_.splice(i, 1);
      removed = true;
      break;
    }
  }

  if (!removed) {
    for (var i = 0; i < this.nestedContainers_.length; ++i) {
      if (this.nestedContainers_[i] === container) {
        this.nestedContainers_.splice(i, 1);
        break;
      }
    }
  }

  if (!jsaction.EventContract.STOP_PROPAGATION) {
    this.updateNestedContainers_();
  }
};


/**
 * Register a dispatcher function. Event info of each event mapped to
 * a jsaction is passed for handling to this callback. The queued
 * events are passed as well to the dispatcher for later replaying
 * once the dispatcher is registered. Clears the event queue to null.
 *
 * @param {function((!jsaction.EventInfo|!Array.<!jsaction.EventInfo>),
 *                  boolean=):void} dispatcher The dispatcher function.
 */
jsaction.EventContract.prototype.dispatchTo = function(dispatcher) {
  this.dispatcher_ = dispatcher;
  if (this.queue_) {
    if (this.queue_.length > 0) {
      // TODO(user): Consider to call dispatcher repeatedly and to
      // pass the fields of event info as separate arguments. This
      // gets rid of the requirement to keep the fields of EventInfo
      // unobfuscated because they are accessed from separate
      // jsbinaries. It would also resolve the issue whether
      // dispatcher may take ownership of the queue object.
      dispatcher(this.queue_);
    }
    this.queue_ = null;
  }
};



/**
 * A class representing a container node and all the event handlers
 * installed on it. Used so that handlers can be cleaned up if the
 * container is removed from the contract.
 *
 * @param {!Element} div The container node. Usually a div but not
 *     constrained to be.
 * @constructor
 */
jsaction.EventContractContainer = function(div) {
  /**
   * @type {!Element}
   */
  this.div = div;

  /**
   * Array of event handlers and their corresponding event types that are
   * installed on this container.
   *
   * @type {!Array.<jsaction.EventHandlerInfo>}
   * @private
   */
  this.handlers_ = [];
};


/**
 * @param {Node} node Candidate child node.
 * @return {boolean} True if this container has node as a child.
 */
jsaction.EventContractContainer.prototype.containsNode = function(node) {
  return jsaction.EventContractContainer.containsNode_(this.div, node);
};


/**
 * Checks whether the container is a child of any of the containers in the
 * given list.
 * @param {!jsaction.EventContractContainer} container The container to check.
 * @param {!Array.<!jsaction.EventContractContainer>} list The list of all the
 *    containers to check against for nesting.
 * @return {boolean} True if the container is nested.
 * @private
 */
jsaction.EventContractContainer.isNested_ = function(container, list) {
  for (var i = 0; i < list.length; ++i) {
    if (list[i].div == container.div) {
      continue;
    }

    if (list[i].containsNode(container.div)) {
      return true;
    }
  }

  return false;
};


/**
 * Determines whether one node is the parent of the other.
 * @param {Node} parent The parent node.
 * @param {Node} child The node to look for in parent.
 * @return {boolean} parent recursively contains child.
 * @private
 */
jsaction.EventContractContainer.containsNode_ = function(parent, child) {
  while (parent != child && child.parentNode) {
    child = child.parentNode;
  }
  return parent == child;
};


/**
 * Installs the provided installer on the div owned by this container,
 * and maintains a reference to resulting handler in order to remove it
 * later if desired.
 *
 * @param {jsaction.ContainerInitializerFunction} installer The
 *     installer returned by
 *     jsaction.EventContract.containerHandlerInstaller_.
 */
jsaction.EventContractContainer.prototype.installHandler = function(installer) {
  this.handlers_.push(installer.call(null, this.div));
};


/**
 * Removes all the handlers installed on this container.
 */
jsaction.EventContractContainer.prototype.cleanUp = function() {
  for (var i = 0; i < this.handlers_.length; ++i) {
    var handlerInfo = this.handlers_[i];
    jsaction.event.removeEventListener(this.div, handlerInfo);
  }

  this.handlers_ = [];
};
