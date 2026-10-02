import {defineClientConfig} from 'vuepress/client';
import HomeLayout from './layouts/HomeLayout.vue';
import ModuleNav from './components/ModuleNav.vue';

export default defineClientConfig({
    enhance({app}) {
        // 总览页导航表：<ModuleNav />
        app.component('ModuleNav', ModuleNav);
    },
    layouts: {HomeLayout},
});
