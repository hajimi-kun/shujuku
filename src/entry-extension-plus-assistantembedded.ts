/**
 * 在不改 plus 现有源码的前提下，把 template-assistant 作为包装层接入。
 *
 * 这个入口会先启动原始 plus 插件，再额外挂载 visualizer assistant 适配层。
 */

import './entry-extension';
import './presentation/bootstrap/visualizer-template-assistant-addon';
