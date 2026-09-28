import { createApp } from "vue";
import App from "./App.vue";
import UiSelect from "./components/UiSelect.vue";
import Icon from "./components/Icon.vue";
import ActionButton from "./components/ActionButton.vue";
import EmptyState from "./components/EmptyState.vue";
import DataTable from "./components/DataTable.vue";
import { cleanText } from "./utils.js";
import "./style.css";

const app = createApp(App);
app
  .component("UiSelect", UiSelect)
  .component("Icon", Icon)
  .component("ActionButton", ActionButton)
  .component("EmptyState", EmptyState)
  .component("DataTable", DataTable);
app.config.globalProperties.$clean = cleanText;
app.mount("#app");
