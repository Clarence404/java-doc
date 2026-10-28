<script setup>
import {Layout} from 'vuepress-theme-hope/client';
import RelatedQuestions from '../components/RelatedQuestions.vue';
</script>

<!-- 默认布局：沿用主题布局，只在正文之后插入「本篇相关面试题」（没有相关题目的页面不显示） -->
<template>
  <Layout>
    <template #contentAfter>
      <RelatedQuestions />
    </template>
  </Layout>
</template>
