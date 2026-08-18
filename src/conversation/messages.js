const { tr } = require("./translations");
function buttons(body, options) { return { kind: "buttons", body, buttons: options }; }
function list(body, rows, buttonText = "Select") { return { kind: "list", body, buttonText, sections: [{ title: "Options", rows }] }; }
function text(body) { return { kind: "text", body }; }
function languageMessage() { return buttons("Please select your language.\nبراہِ کرم اپنی زبان منتخب کریں۔", [{ id: "LANG_EN", title: "🌐 English" }, { id: "LANG_UR", title: "🌐 اردو" }]); }
function mainMenu(language) { return list(tr(language, "welcome"), [
  { id: "MENU_BOOK", title: language === "ur" ? "📅 اپائنٹمنٹ بک کریں" : "📅 Book Appointment" },
  { id: "MENU_MANAGE", title: language === "ur" ? "🗓️ اپائنٹمنٹ سنبھالیں" : "🗓️ Manage Appointment" },
  { id: "MENU_UPLOAD", title: language === "ur" ? "📎 رپورٹ اپ لوڈ" : "📎 Upload Document" },
  { id: "MENU_CLINIC", title: language === "ur" ? "🏥 کلینک معلومات" : "🏥 Clinic Information" },
  { id: "MENU_TREATMENTS", title: language === "ur" ? "🩺 علاج کی معلومات" : "🩺 Treatment Info" },
  { id: "MENU_PROFILE", title: language === "ur" ? "👨‍⚕️ ڈاکٹر کا تعارف" : "👨‍⚕️ Doctor Profile" },
  { id: "MENU_STAFF", title: language === "ur" ? "💬 عملے سے بات کریں" : "💬 Speak to Staff" }
], language === "ur" ? "📋 مینو کھولیں" : "📋 Open Menu"); }
module.exports = { buttons, list, text, languageMessage, mainMenu };
