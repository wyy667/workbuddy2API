<script setup>
import hunyuan from "../assets/models/hunyuan.svg";
import glm from "../assets/models/zhipu-color.svg";
import minimax from "../assets/models/minimax-color.svg";
import kimi from "../assets/models/kimi-color.svg";
import deepseek from "../assets/models/deepseek-color.svg";
defineProps({ vendor: { type: String, required: true }, compact: Boolean });
const logos = {
  Hunyuan: hunyuan,
  GLM: glm,
  MiniMax: minimax,
  Kimi: kimi,
  DeepSeek: deepseek,
};
const initials = {
  Anthropic: "A",
  OpenAI: "O",
  Google: "G",
  Qwen: "Q",
  Other: "W",
};
</script>
<template>
  <span
    class="model-logo"
    :class="[{ compact, 'has-brand': logos[vendor] }, vendor.toLowerCase()]"
  >
    <img
      v-if="logos[vendor]"
      :src="logos[vendor]"
      :alt="(vendor === 'Hunyuan' ? '混元 Hunyuan' : vendor) + ' 标识'"
      width="32"
      height="32"
      decoding="async"
    />
    <span v-else aria-hidden="true">{{
      initials[vendor] || vendor.slice(0, 1)
    }}</span>
  </span>
</template>
<style scoped>
.model-logo {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-size: 23px;
  font-weight: 750;
}
.model-logo.has-brand {
  background: #fff;
  border: 1px solid #e9eae5;
  box-shadow: 0 2px 8px #17211705;
}
.model-logo img {
  display: block;
  width: 32px;
  height: 32px;
  object-fit: contain;
}
.model-logo.anthropic {
  background: var(--orange-soft);
  color: var(--orange);
}
.model-logo.google {
  background: var(--blue-soft);
  color: #4776df;
}
.model-logo.qwen {
  background: var(--purple-soft);
  color: var(--purple);
}
.model-logo.compact {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 12px;
}
.model-logo.compact img {
  width: 16px;
  height: 16px;
}
</style>
