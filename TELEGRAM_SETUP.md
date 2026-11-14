# Запуск Restaurant Order с Telegram на Windows (PowerShell)

## 1. Предварительные требования

Установите Node.js 20+ (рекомендуется 22 LTS), npm, PostgreSQL 15+ и Python 3 (для простого локального сервера frontend). Распакуйте `Restaurant_Order_Telegram_Integrated.zip` и перейдите в папку проекта `restaurant-order`.

Токен бота нужно **перевыпустить через @BotFather**, если он когда-либо публиковался в переписке. Узнать username: откройте бота в Telegram или выполните `getMe` после настройки `.env`; username указывается без `@`. Настройте HTTPS-публичный frontend, если вход выполняется с телефона. `localhost:8000` на телефоне означает сам телефон, а не ваш ПК.

## 2. Установить зависимости и создать файл конфигурации

```powershell
cd .\restaurant-order\backend
npm ci
Copy-Item .env.example .env
notepad .env
```

Проверьте и задайте в `backend/.env`:

```dotenv
DATABASE_URL="postgresql://restaurant_app:YOUR_PASSWORD@localhost:5433/restaurant_order?schema=public"
PORT=4000
NODE_ENV=development
JWT_SECRET="REPLACE_WITH_DISTINCT_LONG_RANDOM_SECRET"
CLIENT_JWT_SECRET="REPLACE_WITH_DIFFERENT_LONG_RANDOM_SECRET"
CORS_ORIGIN="http://localhost:8000"
FRONTEND_BASE_URL="http://localhost:8000"
KIOSK_TOKEN_ENFORCED=true
TELEGRAM_BOT_TOKEN="REPLACE_WITH_NEW_BOT_TOKEN"
TELEGRAM_BOT_USERNAME="YourRestaurantBot"
TELEGRAM_WEBHOOK_SECRET="REPLACE_WITH_RANDOM_URL_SAFE_SECRET"
```

Пароль/порт/имя базы в `DATABASE_URL` должны совпадать с действительным PostgreSQL. Если PostgreSQL слушает `5432`, используйте `5432`; для вашего локального `5433` — `5433`. Для паролей с `@`, `:`, `/`, `#`, `%` применяйте URL encoding. `FRONTEND_BASE_URL` должен указывать на реальный доступный браузеру URL страницы `profile.html` (через публичный HTTPS при входе с телефона). `TELEGRAM_WEBHOOK_SECRET` — случайная строка символов `[A-Za-z0-9_-]`, от 1 до 256, передаётся Telegram как secret_token. Не копируйте реальный `.env` в ZIP или Git.

## 3. Диагностика и миграции PostgreSQL

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 5432,5433 }
psql -h localhost -p 5433 -U restaurant_app -d restaurant_order -c "SELECT current_user, current_database();"
npx prisma validate
npx prisma migrate deploy
npx prisma generate
npm run typecheck
npm run build
```

Если `psql` отсутствует в PATH, используйте его полный путь, например `C:\Program Files\PostgreSQL\16\bin\psql.exe`. Ошибка Prisma `P1000` означает неправильные учётные данные или несоответствие пользователя/пароля в `DATABASE_URL`; проверьте роль в PostgreSQL и пароль в `.env`, не меняя пароли автоматически. Ошибка `P1001` — сервер БД недоступен по хосту/порту. Убедитесь, что Postgres слушает нужный порт (`Get-NetTCPConnection`), и проверьте настройки аутентификации в `pg_hba.conf`. **Не используйте `prisma migrate reset` на рабочей базе.** Новая миграция `20261102000000_telegram_bot` только добавляет столбец и таблицы.

## 4. Запуск backend/frontend (два окна PowerShell)

Backend:

```powershell
cd .\restaurant-order\backend
npm run dev
```

Frontend в новом окне:

```powershell
cd .\restaurant-order\frontend
python -m http.server 8000
```

Откройте `http://localhost:8000/index.html` и проверьте backend на `http://localhost:4000/api/health` (ожидается `{ "ok": true }`). При нестандартном адресе API установите `window.RESTAURANT_API_BASE` до загрузки `api.js` через конфигурацию хостинга; не меняйте существующий дизайн. Убедитесь, что frontend может вызывать backend по CORS. Для локального браузера на том же ПК `localhost` работает; для клиентов на телефоне нужны доступные HTTPS-адреса frontend и API.

## 5. Telegram webhook через публичный HTTPS

Telegram не доставляет webhook на `http://localhost:4000`. Разместите backend за HTTPS reverse proxy или используйте безопасный временный HTTPS-туннель. Адрес API должен принимать `POST https://YOUR_BACKEND_HOST/api/integrations/telegram/webhook`. Webhook и getUpdates/long polling нельзя использовать одновременно. Эта реализация использует **только webhook**.

В PowerShell (не сохраняйте токен в истории или скриншотах):

```powershell
$botToken = Read-Host "Новый токен Telegram-бота"
$webhookSecret = Read-Host "Секрет webhook из .env"
$webhookUrl = "https://YOUR_BACKEND_HOST/api/integrations/telegram/webhook"
$body = @{ url = $webhookUrl; secret_token = $webhookSecret; allowed_updates = @("message", "callback_query") } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/setWebhook" -Method Post -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getWebhookInfo" -Method Get
Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getMe" -Method Get
```

`getWebhookInfo.result.url` должен совпадать с вашим HTTPS URL; проверяйте `last_error_message` при проблемах. Бот должен работать в личном чате. Секрет `TELEGRAM_WEBHOOK_SECRET` из работающего backend должен совпадать с `secret_token` в `setWebhook`.

## 6. Проверка команд, входа и чеков

В личном чате бота отправьте `/start`, затем `/help` и `/login`. Нажмите «Войти на сайте». Авторизуйтесь в существующем клиентском аккаунте и нажмите «Подтвердить вход в Telegram» на странице профиля. При необходимости обновите профиль после входа. Команда `/orders` должна показать именно ваши заказы, `/receipts` — сохранённые оплаченные чеки. Выберите заказ и чек, затем выполните `/logout` и убедитесь, что просмотр личных данных больше недоступен. На странице профиля для привязанного аккаунта можно отдельно включить автоотправку новых оплаченных чеков.

Для гостевого чека откройте ресторанный терминал в существующей сессии, создайте тестовый заказ и используйте предусмотренную демонстрационную оплату. Откройте сохранённый чек, нажмите «Получить в Telegram», затем откройте ссылку в **личном** Telegram-чате и нажмите Start. Повторное использование ссылки должно завершиться отказом; до принятия оплаты наличными ссылка не выдаётся. В базе можно проверить журнал `receipt_dispatches` и очередь `telegram_auto_deliveries`. В финансовых операциях используйте только учебные тестовые данные.

## 7. Автоматизированные тесты на ОТДЕЛЬНОЙ БД

Обычный запуск unit-тестов (без PostgreSQL):

```powershell
cd .\restaurant-order\backend
npm run test:unit
```

Для интеграционных тестов создайте отдельную базу, в имени которой есть слово `test`, и примените к ней миграции. **Не указывайте рабочий DATABASE_URL в TEST_DATABASE_URL. Тесты очищают тестовую базу.**

```powershell
$env:TEST_DATABASE_URL="postgresql://test_user:TEST_PASSWORD@localhost:5433/restaurant_order_test?schema=public"
$env:DATABASE_URL=$env:TEST_DATABASE_URL
npx prisma migrate deploy
npx prisma generate
npm test
Remove-Item Env:DATABASE_URL
Remove-Item Env:TEST_DATABASE_URL
```

Имеющиеся интеграционные тесты отказываются выполнять очистку, если `TEST_DATABASE_URL` отсутствует или имя базы не содержит `test`. Не запускайте интеграционные тесты, используя административный доступ к рабочей базе.

## 8. Ограничения и устранение проблем

Если бот молчит, проверьте настройки `.env`, запись Telegram webhook и сетевую доступность HTTPS. Telegram API должен иметь возможность инициировать исходящие HTTPS-запросы из backend. При блокировке бота пользователем отправка может завершиться статусом FAILED. Автодоставка делает до 5 попыток с задержками; повторное сообщение после аварийного завершения процесса между доставкой и фиксацией SENT теоретически возможно, но повторных платежей не создаёт. DEMO-чеки **не являются фискальными**. Для полноценной проверки в боевом окружении нужны PostgreSQL, зависимости npm, новый Telegram-токен и внешний HTTPS-сервер.
