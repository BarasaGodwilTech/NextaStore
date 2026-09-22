-- Platform-wide payment method catalog. Replaces the hardcoded
-- cash/mtnMomo/airtelMoney/card list that used to be duplicated across
-- cart-page.js, dashboard.js, and both order-creation code paths in
-- orders.js. Seeded with the exact same four codes/labels so this
-- migration changes nothing about what a store can already offer --
-- it only moves the definitions server-side.
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'fa-money-bill',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'UGX',
    "allowedCountries" TEXT[] DEFAULT ARRAY['UG']::TEXT[],
    "environment" TEXT NOT NULL DEFAULT 'live',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentMethod_code_key" ON "PaymentMethod"("code");
CREATE INDEX "PaymentMethod_isActive_idx" ON "PaymentMethod"("isActive");

INSERT INTO "PaymentMethod" ("id", "code", "label", "icon", "isActive", "currency", "allowedCountries", "environment", "sortOrder", "updatedAt") VALUES
    ('pm_cash',        'cash',        'Cash',          'fa-money-bill-wave', true, 'UGX', ARRAY['UG']::TEXT[], 'live', 0, CURRENT_TIMESTAMP),
    ('pm_mtn_momo',    'mtnMomo',     'MTN MoMo',      'fa-mobile-screen',   true, 'UGX', ARRAY['UG']::TEXT[], 'live', 1, CURRENT_TIMESTAMP),
    ('pm_airtel_money','airtelMoney', 'Airtel Money',  'fa-mobile-screen',   true, 'UGX', ARRAY['UG']::TEXT[], 'live', 2, CURRENT_TIMESTAMP),
    ('pm_card',        'card',        'Card',          'fa-credit-card',    true, 'UGX', ARRAY['UG']::TEXT[], 'live', 3, CURRENT_TIMESTAMP);
