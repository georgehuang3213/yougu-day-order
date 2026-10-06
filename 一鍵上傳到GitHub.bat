@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================================
echo   優穀日・一鍵上傳程式碼到 GitHub
echo ========================================================
echo.
echo 正在將所有前端網頁、後台管理、圖片與 API 推送到 GitHub...
echo (若彈出 GitHub 登入視窗，請點選 Authorize 授權即可)
echo.

copy /y index.html public\index.html >nul
copy /y admin.html public\admin.html >nul
git add .
git commit -m "update: sync website changes" >nul 2>&1
git push -u origin main --force

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo   [成功] 全部檔案已成功推送至 GitHub！
    echo   Vercel 將在 20 秒內自動完成部署！
    echo   您可以前往 Vercel 或重新整理點餐網頁查看！
    echo ========================================================
) else (
    echo.
    echo ========================================================
    echo   [提示] 推送遇到問題，您也可以直接在 GitHub 網頁上傳。
    echo ========================================================
)

echo.
pause
