# Third-party 引用清单

LayoutMotion 复用了以下第三方组件源码(非 npm 安装,而是 copy-paste 后改写)。

## Aceternity UI · MIT License

- **Spotlight** — `src/shell/decor/Spotlight.tsx`
  - Source: <https://ui.aceternity.com/components/spotlight>
  - Author: Manu Arora
  - 修改:替换 `cn(@/lib/utils)` → `clsx`;keyframes 移到 `src/styles/decor.css`;改成命名导出。

- **Background Beams** — `src/shell/decor/BackgroundBeams.tsx`
  - Source: <https://ui.aceternity.com/components/background-beams>
  - Author: Manu Arora
  - 修改:替换 `cn(@/lib/utils)` → `clsx`;删去未用的静态描边底图;`useMemo` 锁定随机 transition,降低重渲染开销。

### MIT License 全文(Aceternity UI)

```
MIT License

Copyright (c) Aceternity / Manu Arora

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
