import {defineClientConfig} from 'vuepress/client';
import HomeLayout from './layouts/HomeLayout.vue';
import ModuleNav from './components/ModuleNav.vue';
import InterviewList from './components/InterviewList.vue';

// 开发模式：修改 site.js / config.js 或新增文章时开发服务器会自动重启，
// 这里在连接断开后轮询，服务器恢复即自动刷新浏览器（VuePress 默认只提示手动刷新）
if (import.meta.hot) {
    import.meta.hot.on('vite:ws:disconnect', () => {
        const timer = setInterval(() => {
            fetch(location.href, {method: 'HEAD', cache: 'no-store'})
                .then((res) => {
                    if (res.ok) {
                        clearInterval(timer);
                        location.reload();
                    }
                })
                .catch(() => {});
        }, 1000);
    });
}

export default defineClientConfig({
    enhance({app}) {
        // 总览页导航表：<ModuleNav />
        app.component('ModuleNav', ModuleNav);
        // 题单：<InterviewList page="9_mq" />，由答案页自动生成
        app.component('InterviewList', InterviewList);
    },
    layouts: {HomeLayout},
});
