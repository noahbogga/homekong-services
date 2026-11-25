/*
 * noVNC Keyboard Module - Bundled standalone
 * Copyright (C) 2019 The noVNC authors
 * Licensed under MPL 2.0 or any later version
 *
 * Extracted from github.com/novnc/noVNC for use with Guacamole protocol.
 * Element-scoped keyboard capture with full X11 keysym mapping.
 */
(function(global) {
'use strict';

// === browser detection (minimal) ===
var browser = {
  isMac: function() { return !!(/mac/i).exec(navigator.platform); },
  isWindows: function() { return !!(/win/i).exec(navigator.platform); },
  isIOS: function() { return !!(/ipad|iphone|ipod/i).exec(navigator.platform); }
};

function stopEvent(e) { e.stopPropagation(); e.preventDefault(); }

// === KeyTable (X11 keysyms) ===
var KeyTable = {
  XK_BackSpace:0xff08,XK_Tab:0xff09,XK_Clear:0xff0b,XK_Return:0xff0d,
  XK_Pause:0xff13,XK_Scroll_Lock:0xff14,XK_Escape:0xff1b,XK_Delete:0xffff,
  XK_Multi_key:0xff20,XK_Codeinput:0xff37,XK_SingleCandidate:0xff3c,
  XK_MultipleCandidate:0xff3d,XK_PreviousCandidate:0xff3e,
  XK_Kanji:0xff21,XK_Muhenkan:0xff22,XK_Henkan:0xff23,XK_Romaji:0xff24,
  XK_Hiragana:0xff25,XK_Katakana:0xff26,XK_Hiragana_Katakana:0xff27,
  XK_Zenkaku:0xff28,XK_Hankaku:0xff29,XK_Zenkaku_Hankaku:0xff2a,
  XK_Eisu_toggle:0xff30,XK_Kana_Shift:0xff2e,
  XK_Home:0xff50,XK_Left:0xff51,XK_Up:0xff52,XK_Right:0xff53,XK_Down:0xff54,
  XK_Prior:0xff55,XK_Next:0xff56,XK_End:0xff57,XK_Begin:0xff58,
  XK_Select:0xff60,XK_Print:0xff61,XK_Execute:0xff62,XK_Insert:0xff63,
  XK_Undo:0xff65,XK_Redo:0xff66,XK_Menu:0xff67,XK_Find:0xff68,
  XK_Cancel:0xff69,XK_Help:0xff6a,XK_Mode_switch:0xff7e,XK_Num_Lock:0xff7f,
  XK_KP_Space:0xff80,XK_KP_Enter:0xff8d,
  XK_KP_Home:0xff95,XK_KP_Left:0xff96,XK_KP_Up:0xff97,XK_KP_Right:0xff98,
  XK_KP_Down:0xff99,XK_KP_Prior:0xff9a,XK_KP_Next:0xff9b,
  XK_KP_End:0xff9c,XK_KP_Begin:0xff9d,XK_KP_Insert:0xff9e,XK_KP_Delete:0xff9f,
  XK_KP_Equal:0xffbd,XK_KP_Multiply:0xffaa,XK_KP_Add:0xffab,
  XK_KP_Separator:0xffac,XK_KP_Subtract:0xffad,XK_KP_Decimal:0xffae,
  XK_KP_Divide:0xffaf,
  XK_KP_0:0xffb0,XK_KP_1:0xffb1,XK_KP_2:0xffb2,XK_KP_3:0xffb3,
  XK_KP_4:0xffb4,XK_KP_5:0xffb5,XK_KP_6:0xffb6,XK_KP_7:0xffb7,
  XK_KP_8:0xffb8,XK_KP_9:0xffb9,
  XK_F1:0xffbe,XK_F2:0xffbf,XK_F3:0xffc0,XK_F4:0xffc1,XK_F5:0xffc2,
  XK_F6:0xffc3,XK_F7:0xffc4,XK_F8:0xffc5,XK_F9:0xffc6,XK_F10:0xffc7,
  XK_F11:0xffc8,XK_F12:0xffc9,XK_F13:0xffca,XK_F14:0xffcb,XK_F15:0xffcc,
  XK_F16:0xffcd,XK_F17:0xffce,XK_F18:0xffcf,XK_F19:0xffd0,XK_F20:0xffd1,
  XK_F21:0xffd2,XK_F22:0xffd3,XK_F23:0xffd4,XK_F24:0xffd5,
  XK_F25:0xffd6,XK_F26:0xffd7,XK_F27:0xffd8,XK_F28:0xffd9,XK_F29:0xffda,
  XK_F30:0xffdb,XK_F31:0xffdc,XK_F32:0xffdd,XK_F33:0xffde,XK_F34:0xffdf,XK_F35:0xffe0,
  XK_Shift_L:0xffe1,XK_Shift_R:0xffe2,XK_Control_L:0xffe3,XK_Control_R:0xffe4,
  XK_Caps_Lock:0xffe5,XK_Meta_L:0xffe7,XK_Meta_R:0xffe8,
  XK_Alt_L:0xffe9,XK_Alt_R:0xffea,XK_Super_L:0xffeb,XK_Super_R:0xffec,
  XK_ISO_Level3_Shift:0xfe03,XK_ISO_Next_Group:0xfe08,
  XK_ISO_Prev_Group:0xfe0a,XK_ISO_First_Group:0xfe0c,XK_ISO_Last_Group:0xfe0e,
  XK_space:0x0020,
  XK_0:0x0030,XK_1:0x0031,XK_2:0x0032,XK_3:0x0033,XK_4:0x0034,
  XK_5:0x0035,XK_6:0x0036,XK_7:0x0037,XK_8:0x0038,XK_9:0x0039,
  XK_equal:0x003d,XK_plus:0x002b,XK_minus:0x002d,XK_asterisk:0x002a,
  XK_slash:0x002f,XK_period:0x002e,XK_comma:0x002c,
  XK_Hangul:0xff31,XK_Hangul_Hanja:0xff34,XK_Hangul_Jeonja:0xff38,
  XF86XK_Copy:0x1008FF57,XF86XK_Cut:0x1008FF58,XF86XK_Paste:0x1008FF6D,
  XF86XK_AudioLowerVolume:0x1008FF11,XF86XK_AudioMute:0x1008FF12,
  XF86XK_AudioRaiseVolume:0x1008FF13,XF86XK_AudioMicMute:0x1008FFB2,
  XF86XK_MonBrightnessUp:0x1008FF02,XF86XK_MonBrightnessDown:0x1008FF03,
  XF86XK_Eject:0x1008FF2C,XF86XK_LogOff:0x1008FF61,
  XF86XK_PowerOff:0x1008FF2A,XF86XK_PowerDown:0x1008FF21,
  XF86XK_Standby:0x1008FF10,XF86XK_WakeUp:0x1008FF2B,
  XF86XK_Hibernate:0x1008FFA8,
  XF86XK_ZoomIn:0x1008FF8B,XF86XK_ZoomOut:0x1008FF8C,
  XF86XK_Back:0x1008FF26,XF86XK_Forward:0x1008FF27,
  XF86XK_Stop:0x1008FF28,XF86XK_Refresh:0x1008FF29,
  XF86XK_Favorites:0x1008FF30,XF86XK_HomePage:0x1008FF18,
  XF86XK_Search:0x1008FF1B,
  XF86XK_AudioPlay:0x1008FF14,XF86XK_AudioStop:0x1008FF15,
  XF86XK_AudioPrev:0x1008FF16,XF86XK_AudioNext:0x1008FF17,
  XF86XK_AudioPause:0x1008FF31,XF86XK_AudioRecord:0x1008FF1C,
  XF86XK_AudioForward:0x1008FF97,XF86XK_AudioRewind:0x1008FF3E,
  XF86XK_Mail:0x1008FF19,XF86XK_MyComputer:0x1008FF33,
  XF86XK_Calculator:0x1008FF1D,XF86XK_Calendar:0x1008FF20,
  XF86XK_Phone:0x1008FF6E,XF86XK_AudioMedia:0x1008FF32,
  XF86XK_Music:0x1008FF92,XF86XK_WWW:0x1008FF2E,
  XF86XK_WebCam:0x1008FF8F,XF86XK_Word:0x1008FF89,
  XF86XK_Excel:0x1008FF5C,XF86XK_ScreenSaver:0x1008FF2D,
  XF86XK_Open:0x1008FF6B,XF86XK_New:0x1008FF68,
  XF86XK_Close:0x1008FF56,XF86XK_Reply:0x1008FF72,
  XF86XK_MailForward:0x1008FF90,XF86XK_Send:0x1008FF7B,
  XF86XK_Save:0x1008FF77,XF86XK_Spell:0x1008FF7C,
  XF86XK_BrightnessAdjust:0x1008FF3B,XF86XK_AudioCycleTrack:0x1008FF9B,
  XF86XK_AudioRandomPlay:0x1008FF99,XF86XK_SplitScreen:0x1008FF7D,
  XF86XK_Subtitle:0x1008FF9A,XF86XK_Next_VMode:0x1008FE22
};

// === vkeys: Windows Virtual-Key codes → HTML key codes ===
var vkeys = {
  0x08:'Backspace',0x09:'Tab',0x0a:'NumpadClear',0x0d:'Enter',
  0x10:'ShiftLeft',0x11:'ControlLeft',0x12:'AltLeft',0x13:'Pause',
  0x14:'CapsLock',0x15:'Lang1',0x19:'Lang2',0x1b:'Escape',
  0x1c:'Convert',0x1d:'NonConvert',0x20:'Space',
  0x21:'PageUp',0x22:'PageDown',0x23:'End',0x24:'Home',
  0x25:'ArrowLeft',0x26:'ArrowUp',0x27:'ArrowRight',0x28:'ArrowDown',
  0x29:'Select',0x2c:'PrintScreen',0x2d:'Insert',0x2e:'Delete',0x2f:'Help',
  0x30:'Digit0',0x31:'Digit1',0x32:'Digit2',0x33:'Digit3',0x34:'Digit4',
  0x35:'Digit5',0x36:'Digit6',0x37:'Digit7',0x38:'Digit8',0x39:'Digit9',
  0x5b:'MetaLeft',0x5c:'MetaRight',0x5d:'ContextMenu',0x5f:'Sleep',
  0x60:'Numpad0',0x61:'Numpad1',0x62:'Numpad2',0x63:'Numpad3',
  0x64:'Numpad4',0x65:'Numpad5',0x66:'Numpad6',0x67:'Numpad7',
  0x68:'Numpad8',0x69:'Numpad9',0x6a:'NumpadMultiply',0x6b:'NumpadAdd',
  0x6c:'NumpadDecimal',0x6d:'NumpadSubtract',0x6e:'NumpadDecimal',0x6f:'NumpadDivide',
  0x70:'F1',0x71:'F2',0x72:'F3',0x73:'F4',0x74:'F5',0x75:'F6',
  0x76:'F7',0x77:'F8',0x78:'F9',0x79:'F10',0x7a:'F11',0x7b:'F12',
  0x7c:'F13',0x7d:'F14',0x7e:'F15',0x7f:'F16',0x80:'F17',0x81:'F18',
  0x82:'F19',0x83:'F20',0x84:'F21',0x85:'F22',0x86:'F23',0x87:'F24',
  0x90:'NumLock',0x91:'ScrollLock',
  0xa6:'BrowserBack',0xa7:'BrowserForward',0xa8:'BrowserRefresh',
  0xa9:'BrowserStop',0xaa:'BrowserSearch',0xab:'BrowserFavorites',
  0xac:'BrowserHome',0xad:'AudioVolumeMute',0xae:'AudioVolumeDown',
  0xaf:'AudioVolumeUp',0xb0:'MediaTrackNext',0xb1:'MediaTrackPrevious',
  0xb2:'MediaStop',0xb3:'MediaPlayPause',0xb4:'LaunchMail',
  0xb5:'MediaSelect',0xb6:'LaunchApp1',0xb7:'LaunchApp2',
  0xe1:'AltRight'
};

// === fixedkeys: physical code → key value fallback ===
var fixedkeys = {
  'Backspace':'Backspace','AltLeft':'Alt','AltRight':'Alt',
  'CapsLock':'CapsLock','ContextMenu':'ContextMenu',
  'ControlLeft':'Control','ControlRight':'Control',
  'Enter':'Enter','MetaLeft':'Meta','MetaRight':'Meta',
  'ShiftLeft':'Shift','ShiftRight':'Shift','Tab':'Tab',
  'Delete':'Delete','End':'End','Help':'Help','Home':'Home',
  'Insert':'Insert','PageDown':'PageDown','PageUp':'PageUp',
  'ArrowDown':'ArrowDown','ArrowLeft':'ArrowLeft',
  'ArrowRight':'ArrowRight','ArrowUp':'ArrowUp',
  'NumLock':'NumLock','NumpadBackspace':'Backspace','NumpadClear':'Clear',
  'Escape':'Escape',
  'F1':'F1','F2':'F2','F3':'F3','F4':'F4','F5':'F5','F6':'F6',
  'F7':'F7','F8':'F8','F9':'F9','F10':'F10','F11':'F11','F12':'F12',
  'F13':'F13','F14':'F14','F15':'F15','F16':'F16','F17':'F17','F18':'F18',
  'F19':'F19','F20':'F20','F21':'F21','F22':'F22','F23':'F23','F24':'F24',
  'PrintScreen':'PrintScreen','ScrollLock':'ScrollLock','Pause':'Pause',
  'BrowserBack':'BrowserBack','BrowserFavorites':'BrowserFavorites',
  'BrowserForward':'BrowserForward','BrowserHome':'BrowserHome',
  'BrowserRefresh':'BrowserRefresh','BrowserSearch':'BrowserSearch',
  'BrowserStop':'BrowserStop','Eject':'Eject',
  'LaunchApp1':'LaunchMyComputer','LaunchApp2':'LaunchCalendar',
  'LaunchMail':'LaunchMail','MediaPlayPause':'MediaPlay',
  'MediaStop':'MediaStop','MediaTrackNext':'MediaTrackNext',
  'MediaTrackPrevious':'MediaTrackPrevious',
  'Power':'Power','Sleep':'Sleep',
  'AudioVolumeDown':'AudioVolumeDown','AudioVolumeMute':'AudioVolumeMute',
  'AudioVolumeUp':'AudioVolumeUp','WakeUp':'WakeUp'
};

// === DOMKeyTable: HTML key value → keysym (by location) ===
var DOMKeyTable = {};
function addStd(k,s){DOMKeyTable[k]=[s,s,s,s];}
function addLR(k,l,r){DOMKeyTable[k]=[l,l,r,l];}
function addNP(k,s,n){DOMKeyTable[k]=[s,s,s,n];}

addLR("Alt",KeyTable.XK_Alt_L,KeyTable.XK_Alt_R);
addStd("AltGraph",KeyTable.XK_ISO_Level3_Shift);
addStd("CapsLock",KeyTable.XK_Caps_Lock);
addLR("Control",KeyTable.XK_Control_L,KeyTable.XK_Control_R);
addLR("Meta",KeyTable.XK_Super_L,KeyTable.XK_Super_R);
addStd("NumLock",KeyTable.XK_Num_Lock);
addStd("ScrollLock",KeyTable.XK_Scroll_Lock);
addLR("Shift",KeyTable.XK_Shift_L,KeyTable.XK_Shift_R);
addNP("Enter",KeyTable.XK_Return,KeyTable.XK_KP_Enter);
addStd("Tab",KeyTable.XK_Tab);
addNP(" ",KeyTable.XK_space,KeyTable.XK_KP_Space);
addNP("ArrowDown",KeyTable.XK_Down,KeyTable.XK_KP_Down);
addNP("ArrowLeft",KeyTable.XK_Left,KeyTable.XK_KP_Left);
addNP("ArrowRight",KeyTable.XK_Right,KeyTable.XK_KP_Right);
addNP("ArrowUp",KeyTable.XK_Up,KeyTable.XK_KP_Up);
addNP("End",KeyTable.XK_End,KeyTable.XK_KP_End);
addNP("Home",KeyTable.XK_Home,KeyTable.XK_KP_Home);
addNP("PageDown",KeyTable.XK_Next,KeyTable.XK_KP_Next);
addNP("PageUp",KeyTable.XK_Prior,KeyTable.XK_KP_Prior);
addStd("Backspace",KeyTable.XK_BackSpace);
addNP("Clear",KeyTable.XK_Clear,KeyTable.XK_KP_Begin);
addStd("Copy",KeyTable.XF86XK_Copy);
addStd("Cut",KeyTable.XF86XK_Cut);
addNP("Delete",KeyTable.XK_Delete,KeyTable.XK_KP_Delete);
addNP("Insert",KeyTable.XK_Insert,KeyTable.XK_KP_Insert);
addStd("Paste",KeyTable.XF86XK_Paste);
addStd("Redo",KeyTable.XK_Redo);
addStd("Undo",KeyTable.XK_Undo);
addStd("Cancel",KeyTable.XK_Cancel);
addStd("ContextMenu",KeyTable.XK_Menu);
addStd("Escape",KeyTable.XK_Escape);
addStd("Execute",KeyTable.XK_Execute);
addStd("Find",KeyTable.XK_Find);
addStd("Help",KeyTable.XK_Help);
addStd("Pause",KeyTable.XK_Pause);
addStd("Select",KeyTable.XK_Select);
addStd("ZoomIn",KeyTable.XF86XK_ZoomIn);
addStd("ZoomOut",KeyTable.XF86XK_ZoomOut);
addStd("BrightnessDown",KeyTable.XF86XK_MonBrightnessDown);
addStd("BrightnessUp",KeyTable.XF86XK_MonBrightnessUp);
addStd("Eject",KeyTable.XF86XK_Eject);
addStd("LogOff",KeyTable.XF86XK_LogOff);
addStd("Power",KeyTable.XF86XK_PowerOff);
addStd("PowerOff",KeyTable.XF86XK_PowerDown);
addStd("PrintScreen",KeyTable.XK_Print);
addStd("Hibernate",KeyTable.XF86XK_Hibernate);
addStd("Standby",KeyTable.XF86XK_Standby);
addStd("WakeUp",KeyTable.XF86XK_WakeUp);
addStd("AllCandidates",KeyTable.XK_MultipleCandidate);
addStd("Alphanumeric",KeyTable.XK_Eisu_toggle);
addStd("CodeInput",KeyTable.XK_Codeinput);
addStd("Compose",KeyTable.XK_Multi_key);
addStd("Convert",KeyTable.XK_Henkan);
addStd("GroupFirst",KeyTable.XK_ISO_First_Group);
addStd("GroupLast",KeyTable.XK_ISO_Last_Group);
addStd("GroupNext",KeyTable.XK_ISO_Next_Group);
addStd("GroupPrevious",KeyTable.XK_ISO_Prev_Group);
addStd("NonConvert",KeyTable.XK_Muhenkan);
addStd("PreviousCandidate",KeyTable.XK_PreviousCandidate);
addStd("SingleCandidate",KeyTable.XK_SingleCandidate);
addStd("HangulMode",KeyTable.XK_Hangul);
addStd("HanjaMode",KeyTable.XK_Hangul_Hanja);
addStd("JunjaMode",KeyTable.XK_Hangul_Jeonja);
addStd("Eisu",KeyTable.XK_Eisu_toggle);
addStd("Hankaku",KeyTable.XK_Hankaku);
addStd("Hiragana",KeyTable.XK_Hiragana);
addStd("HiraganaKatakana",KeyTable.XK_Hiragana_Katakana);
addStd("KanaMode",KeyTable.XK_Kana_Shift);
addStd("KanjiMode",KeyTable.XK_Kanji);
addStd("Katakana",KeyTable.XK_Katakana);
addStd("Romaji",KeyTable.XK_Romaji);
addStd("Zenkaku",KeyTable.XK_Zenkaku);
addStd("ZenkakuHankaku",KeyTable.XK_Zenkaku_Hankaku);
addStd("F1",KeyTable.XK_F1);addStd("F2",KeyTable.XK_F2);
addStd("F3",KeyTable.XK_F3);addStd("F4",KeyTable.XK_F4);
addStd("F5",KeyTable.XK_F5);addStd("F6",KeyTable.XK_F6);
addStd("F7",KeyTable.XK_F7);addStd("F8",KeyTable.XK_F8);
addStd("F9",KeyTable.XK_F9);addStd("F10",KeyTable.XK_F10);
addStd("F11",KeyTable.XK_F11);addStd("F12",KeyTable.XK_F12);
addStd("F13",KeyTable.XK_F13);addStd("F14",KeyTable.XK_F14);
addStd("F15",KeyTable.XK_F15);addStd("F16",KeyTable.XK_F16);
addStd("F17",KeyTable.XK_F17);addStd("F18",KeyTable.XK_F18);
addStd("F19",KeyTable.XK_F19);addStd("F20",KeyTable.XK_F20);
addStd("F21",KeyTable.XK_F21);addStd("F22",KeyTable.XK_F22);
addStd("F23",KeyTable.XK_F23);addStd("F24",KeyTable.XK_F24);
addStd("AudioVolumeDown",KeyTable.XF86XK_AudioLowerVolume);
addStd("AudioVolumeUp",KeyTable.XF86XK_AudioRaiseVolume);
addStd("AudioVolumeMute",KeyTable.XF86XK_AudioMute);
addStd("MicrophoneVolumeMute",KeyTable.XF86XK_AudioMicMute);
addStd("MediaFastForward",KeyTable.XF86XK_AudioForward);
addStd("MediaPause",KeyTable.XF86XK_AudioPause);
addStd("MediaPlay",KeyTable.XF86XK_AudioPlay);
addStd("MediaRecord",KeyTable.XF86XK_AudioRecord);
addStd("MediaRewind",KeyTable.XF86XK_AudioRewind);
addStd("MediaStop",KeyTable.XF86XK_AudioStop);
addStd("MediaTrackNext",KeyTable.XF86XK_AudioNext);
addStd("MediaTrackPrevious",KeyTable.XF86XK_AudioPrev);
addStd("LaunchApplication1",KeyTable.XF86XK_MyComputer);
addStd("LaunchApplication2",KeyTable.XF86XK_Calculator);
addStd("LaunchCalendar",KeyTable.XF86XK_Calendar);
addStd("LaunchMail",KeyTable.XF86XK_Mail);
addStd("LaunchMediaPlayer",KeyTable.XF86XK_AudioMedia);
addStd("LaunchMusicPlayer",KeyTable.XF86XK_Music);
addStd("LaunchPhone",KeyTable.XF86XK_Phone);
addStd("LaunchScreenSaver",KeyTable.XF86XK_ScreenSaver);
addStd("LaunchSpreadsheet",KeyTable.XF86XK_Excel);
addStd("LaunchWebBrowser",KeyTable.XF86XK_WWW);
addStd("LaunchWebCam",KeyTable.XF86XK_WebCam);
addStd("LaunchWordProcessor",KeyTable.XF86XK_Word);
addStd("BrowserBack",KeyTable.XF86XK_Back);
addStd("BrowserFavorites",KeyTable.XF86XK_Favorites);
addStd("BrowserForward",KeyTable.XF86XK_Forward);
addStd("BrowserHome",KeyTable.XF86XK_HomePage);
addStd("BrowserRefresh",KeyTable.XF86XK_Refresh);
addStd("BrowserSearch",KeyTable.XF86XK_Search);
addStd("BrowserStop",KeyTable.XF86XK_Stop);
addNP("=",KeyTable.XK_equal,KeyTable.XK_KP_Equal);
addNP("+",KeyTable.XK_plus,KeyTable.XK_KP_Add);
addNP("-",KeyTable.XK_minus,KeyTable.XK_KP_Subtract);
addNP("*",KeyTable.XK_asterisk,KeyTable.XK_KP_Multiply);
addNP("/",KeyTable.XK_slash,KeyTable.XK_KP_Divide);
addNP(".",KeyTable.XK_period,KeyTable.XK_KP_Decimal);
addNP(",",KeyTable.XK_comma,KeyTable.XK_KP_Separator);
addNP("0",KeyTable.XK_0,KeyTable.XK_KP_0);addNP("1",KeyTable.XK_1,KeyTable.XK_KP_1);
addNP("2",KeyTable.XK_2,KeyTable.XK_KP_2);addNP("3",KeyTable.XK_3,KeyTable.XK_KP_3);
addNP("4",KeyTable.XK_4,KeyTable.XK_KP_4);addNP("5",KeyTable.XK_5,KeyTable.XK_KP_5);
addNP("6",KeyTable.XK_6,KeyTable.XK_KP_6);addNP("7",KeyTable.XK_7,KeyTable.XK_KP_7);
addNP("8",KeyTable.XK_8,KeyTable.XK_KP_8);addNP("9",KeyTable.XK_9,KeyTable.XK_KP_9);

// === keysymdef: Unicode codepoint → X11 keysym lookup ===
function keysymLookup(u) {
  if (u >= 0x20 && u <= 0xff) return u;
  return 0x01000000 | u;
}

// === KeyboardUtil ===
function getKeycode(evt) {
  if (evt.code) {
    switch (evt.code) {
      case 'OSLeft': return 'MetaLeft';
      case 'OSRight': return 'MetaRight';
    }
    return evt.code;
  }
  if (evt.keyCode && evt.keyCode !== 229) {
    if (evt.keyCode in vkeys) {
      var code = vkeys[evt.keyCode];
      if (browser.isMac() && code === 'ContextMenu') code = 'MetaRight';
      if (evt.location === 2) {
        switch (code) {
          case 'ShiftLeft': return 'ShiftRight';
          case 'ControlLeft': return 'ControlRight';
          case 'AltLeft': return 'AltRight';
        }
      }
      if (evt.location === 3) {
        switch (code) {
          case 'Delete': return 'NumpadDecimal';
          case 'Insert': return 'Numpad0';
          case 'End': return 'Numpad1';
          case 'ArrowDown': return 'Numpad2';
          case 'PageDown': return 'Numpad3';
          case 'ArrowLeft': return 'Numpad4';
          case 'ArrowRight': return 'Numpad6';
          case 'Home': return 'Numpad7';
          case 'ArrowUp': return 'Numpad8';
          case 'PageUp': return 'Numpad9';
          case 'Enter': return 'NumpadEnter';
        }
      }
      return code;
    }
  }
  return 'Unidentified';
}

function getKey(evt) {
  if (evt.key !== undefined && evt.key !== 'Unidentified') {
    switch (evt.key) {
      case 'OS': return 'Meta';
      case 'LaunchMyComputer': return 'LaunchApplication1';
      case 'LaunchCalculator': return 'LaunchApplication2';
      case 'UIKeyInputUpArrow': return 'ArrowUp';
      case 'UIKeyInputDownArrow': return 'ArrowDown';
      case 'UIKeyInputLeftArrow': return 'ArrowLeft';
      case 'UIKeyInputRightArrow': return 'ArrowRight';
      case 'UIKeyInputEscape': return 'Escape';
    }
    if (evt.key === '\x00' && evt.code === 'NumpadDecimal') return 'Delete';
    return evt.key;
  }
  var code = getKeycode(evt);
  if (code in fixedkeys) return fixedkeys[code];
  if (evt.charCode) return String.fromCharCode(evt.charCode);
  return 'Unidentified';
}

function getKeysym(evt) {
  var key = getKey(evt);
  if (key === 'Unidentified') return null;

  if (key in DOMKeyTable) {
    var location = evt.location;
    if (key === 'Meta' && location === 0) location = 2;
    if (key === 'Clear' && location === 3) {
      if (getKeycode(evt) === 'NumLock') location = 0;
    }
    if (location === undefined || location > 3) location = 0;
    if (key === 'Meta') {
      var c = getKeycode(evt);
      if (c === 'AltLeft') return KeyTable.XK_Meta_L;
      if (c === 'AltRight') return KeyTable.XK_Meta_R;
    }
    if (key === 'Clear' && getKeycode(evt) === 'NumLock') return KeyTable.XK_Num_Lock;
    if (browser.isWindows()) {
      switch (key) {
        case 'Zenkaku': case 'Hankaku': return KeyTable.XK_Zenkaku_Hankaku;
        case 'Romaji': case 'KanaMode': return KeyTable.XK_Romaji;
      }
    }
    return DOMKeyTable[key][location];
  }

  if (key.length !== 1) return null;
  var cp = key.charCodeAt(0);
  if (cp) return keysymLookup(cp);
  return null;
}

// === Keyboard class ===
function Keyboard(target) {
  this._target = target || null;
  this._keyDownList = {};
  this._altGrArmed = false;
  this._altGrTimeout = null;
  this._altGrCtrlTime = 0;
  this.onkeyevent = function(){};

  var self = this;
  this._eventHandlers = {
    'keydown': function(e) { self._handleKeyDown(e); },
    'keyup': function(e) { self._handleKeyUp(e); },
    'blur': function() { self._allKeysUp(); }
  };
}

Keyboard.prototype._sendKeyEvent = function(keysym, code, down) {
  if (down) {
    this._keyDownList[code] = keysym;
  } else {
    if (!(code in this._keyDownList)) return;
    delete this._keyDownList[code];
  }
  this.onkeyevent(keysym, code, down);
};

Keyboard.prototype._handleKeyDown = function(e) {
  var code = getKeycode(e);
  var keysym = getKeysym(e);

  if (this._altGrArmed) {
    this._altGrArmed = false;
    clearTimeout(this._altGrTimeout);
    if (code === "AltRight" && (e.timeStamp - this._altGrCtrlTime) < 50) {
      keysym = KeyTable.XK_ISO_Level3_Shift;
    } else {
      this._sendKeyEvent(KeyTable.XK_Control_L, "ControlLeft", true);
    }
  }

  if (code === 'Unidentified') {
    if (keysym) {
      this._sendKeyEvent(keysym, code, true);
      this._sendKeyEvent(keysym, code, false);
    }
    stopEvent(e); return;
  }

  if (browser.isMac() || browser.isIOS()) {
    switch (keysym) {
      case KeyTable.XK_Super_L: keysym = KeyTable.XK_Alt_L; break;
      case KeyTable.XK_Super_R: keysym = KeyTable.XK_Super_L; break;
      case KeyTable.XK_Alt_L: keysym = KeyTable.XK_Mode_switch; break;
      case KeyTable.XK_Alt_R: keysym = KeyTable.XK_ISO_Level3_Shift; break;
    }
  }

  if (code in this._keyDownList) keysym = this._keyDownList[code];

  if ((browser.isMac() || browser.isIOS()) &&
      (e.metaKey && code !== 'MetaLeft' && code !== 'MetaRight')) {
    this._sendKeyEvent(keysym, code, true);
    this._sendKeyEvent(keysym, code, false);
    stopEvent(e); return;
  }

  if ((browser.isMac() || browser.isIOS()) && code === 'CapsLock') {
    this._sendKeyEvent(KeyTable.XK_Caps_Lock, 'CapsLock', true);
    this._sendKeyEvent(KeyTable.XK_Caps_Lock, 'CapsLock', false);
    stopEvent(e); return;
  }

  var jpBadKeys = [KeyTable.XK_Zenkaku_Hankaku, KeyTable.XK_Eisu_toggle,
    KeyTable.XK_Katakana, KeyTable.XK_Hiragana, KeyTable.XK_Romaji];
  if (browser.isWindows() && jpBadKeys.indexOf(keysym) !== -1) {
    this._sendKeyEvent(keysym, code, true);
    this._sendKeyEvent(keysym, code, false);
    stopEvent(e); return;
  }

  stopEvent(e);

  if (code === "ControlLeft" && browser.isWindows() && !("ControlLeft" in this._keyDownList)) {
    this._altGrArmed = true;
    var self = this;
    this._altGrTimeout = setTimeout(function() { self._interruptAltGrSequence(); }, 100);
    this._altGrCtrlTime = e.timeStamp;
    return;
  }

  this._sendKeyEvent(keysym, code, true);
};

Keyboard.prototype._handleKeyUp = function(e) {
  stopEvent(e);
  var code = getKeycode(e);
  this._interruptAltGrSequence();

  if ((browser.isMac() || browser.isIOS()) && code === 'CapsLock') {
    this._sendKeyEvent(KeyTable.XK_Caps_Lock, 'CapsLock', true);
    this._sendKeyEvent(KeyTable.XK_Caps_Lock, 'CapsLock', false);
    return;
  }

  this._sendKeyEvent(this._keyDownList[code], code, false);

  if (browser.isWindows() && (code === 'ShiftLeft' || code === 'ShiftRight')) {
    if ('ShiftRight' in this._keyDownList)
      this._sendKeyEvent(this._keyDownList['ShiftRight'], 'ShiftRight', false);
    if ('ShiftLeft' in this._keyDownList)
      this._sendKeyEvent(this._keyDownList['ShiftLeft'], 'ShiftLeft', false);
  }
};

Keyboard.prototype._interruptAltGrSequence = function() {
  if (this._altGrArmed) {
    this._altGrArmed = false;
    clearTimeout(this._altGrTimeout);
    this._sendKeyEvent(KeyTable.XK_Control_L, "ControlLeft", true);
  }
};

Keyboard.prototype._allKeysUp = function() {
  this._interruptAltGrSequence();
  for (var code in this._keyDownList) {
    this._sendKeyEvent(this._keyDownList[code], code, false);
  }
};

Keyboard.prototype.grab = function() {
  this._target.addEventListener('keydown', this._eventHandlers.keydown);
  this._target.addEventListener('keyup', this._eventHandlers.keyup);
  window.addEventListener('blur', this._eventHandlers.blur);
};

Keyboard.prototype.ungrab = function() {
  this._target.removeEventListener('keydown', this._eventHandlers.keydown);
  this._target.removeEventListener('keyup', this._eventHandlers.keyup);
  window.removeEventListener('blur', this._eventHandlers.blur);
  this._allKeysUp();
};

global.NoVNCKeyboard = Keyboard;
})(window);
