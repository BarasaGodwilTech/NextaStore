/**
 * GrowthKit: everything a partner needs to REACH people, in one place.
 *   GrowthKit.messages(ctx)   ready-to-send messages (WhatsApp status, direct, group, follow-ups)
 *   GrowthKit.pitch(ctx)      the 60-second pitch, the 5-minute demo and answers to common objections
 *   GrowthKit.cardSvg(ctx)    a portrait invite card (SVG) with the partner's code and an OFFLINE QR code
 *   GrowthKit.cardBlob(ctx)   the same card as a PNG blob, ready to download or share to WhatsApp status
 *   GrowthKit.mount(el, ctx)  renders the Share Studio (and, for the Crew, the Pitch Kit) into el
 *
 * ctx = { program: 'circle'|'scout', code, link, firstName, rules }   (rules = GET /growth/rules)
 * Numbers (price, trial length) come from the server's rules, never typed in here.
 * Needs growth-qr.js for the QR code; without it the card still works, just without the QR.
 */
(function (root) {
    'use strict';
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ugx = (n) => `UGX ${Number(n || 0).toLocaleString('en-UG')}`;
    // Brand lockups (white, for dark backgrounds), from brand kit v5 svg/lockup-*-white.svg. Embedded so the card is one file that works offline.
    const LOCKUP = { circle: { w: 824, h: 220, svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 824 220\"><defs><linearGradient id=\"tile\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#0F5A41\"/><stop offset=\"100%\" stop-color=\"#062A1D\"/></linearGradient><radialGradient id=\"dot\" cx=\"35%\" cy=\"35%\" r=\"75%\"><stop offset=\"0%\" stop-color=\"#FFD88A\"/><stop offset=\"100%\" stop-color=\"#FFB038\"/></radialGradient><mask id=\"halo\" maskUnits=\"userSpaceOnUse\" x=\"-40\" y=\"-40\" width=\"300\" height=\"300\"><rect x=\"-40\" y=\"-40\" width=\"300\" height=\"300\" fill=\"#fff\"/><circle cx=\"141.02\" cy=\"77.00\" r=\"19.5\" fill=\"#000\"/></mask></defs><rect width=\"220\" height=\"220\" rx=\"48\" fill=\"url(#tile)\"/><g mask=\"url(#halo)\"><path d=\"M 166.45 102.07 A 57 57 0 1 1 121.85 54.25\" fill=\"none\" stroke=\"#2EDDA2\" stroke-width=\"15\" stroke-linecap=\"round\"/><path d=\"M79.98 81.00 L113.73 81.17 L122.89 136.46 L123.74 81.17 L140.02 81.17 L140.02 138.66 L119.50 139.34 L105.93 138.15 L98.13 84.73 L96.77 83.37 L96.60 138.83 L79.98 138.66Z\" fill=\"#FFFFFF\"/></g><path d=\"M126.02 77.00a15 15 0 1 0 30 0a15 15 0 1 0 -30 0ZM138.72 72.30A2.3 2.3 0 0 1 143.32 72.30L143.32 74.70L145.72 74.70A2.3 2.3 0 0 1 145.72 79.30L143.32 79.30L143.32 81.70A2.3 2.3 0 0 1 138.72 81.70L138.72 79.30L136.32 79.30A2.3 2.3 0 0 1 136.32 74.70L138.72 74.70Z\" fill=\"url(#dot)\" fill-rule=\"evenodd\"/><path d=\"M300.8 118.0H290.2L272.4 91.2V118.0H261.8V74.5H272.4L290.2 101.4V74.5H300.8Z M340.9 103.2H316.9Q317.1 106.5 319.0 108.2Q320.8 109.9 323.5 109.9Q327.4 109.9 329.0 106.5H340.3Q339.4 109.9 337.1 112.7Q334.9 115.4 331.5 116.9Q328.1 118.5 323.8 118.5Q318.8 118.5 314.8 116.3Q310.8 114.2 308.6 110.1Q306.4 106.1 306.4 100.7Q306.4 95.3 308.6 91.3Q310.8 87.2 314.7 85.1Q318.7 82.9 323.8 82.9Q328.9 82.9 332.8 85.0Q336.7 87.1 338.9 91.0Q341.1 94.9 341.1 100.1Q341.1 101.6 340.9 103.2ZM330.2 97.4Q330.2 94.6 328.4 93.0Q326.5 91.4 323.7 91.4Q321.1 91.4 319.2 93.0Q317.4 94.5 317.0 97.4Z M367.1 118.0 360.5 108.4 354.9 118.0H343.4L354.8 100.3L343.1 83.4H355.0L361.7 93.0L367.2 83.4H378.7L367.1 100.8L379.0 118.0Z M402.4 109.0V118.0H397.0Q391.2 118.0 388.0 115.2Q384.8 112.4 384.8 106.0V92.2H380.6V83.4H384.8V75.0H395.4V83.4H402.3V92.2H395.4V106.1Q395.4 107.6 396.1 108.3Q396.9 109.0 398.6 109.0Z M421.4 82.9Q425.1 82.9 427.8 84.4Q430.6 85.9 432.1 88.3V83.4H442.7V118.0H432.1V113.1Q430.5 115.5 427.8 117.0Q425.0 118.5 421.4 118.5Q417.2 118.5 413.7 116.3Q410.2 114.1 408.2 110.0Q406.2 106.0 406.2 100.6Q406.2 95.3 408.2 91.3Q410.2 87.2 413.7 85.1Q417.2 82.9 421.4 82.9ZM424.5 92.1Q421.4 92.1 419.2 94.4Q417.0 96.7 417.0 100.6Q417.0 104.6 419.2 106.9Q421.4 109.3 424.5 109.3Q427.7 109.3 429.9 107.0Q432.1 104.7 432.1 100.7Q432.1 96.7 429.9 94.4Q427.7 92.1 424.5 92.1Z M449.1 105.0H460.4Q460.7 107.4 462.1 108.7Q463.5 109.9 465.8 109.9Q468.2 109.9 469.5 108.9Q470.9 107.8 470.9 105.8Q470.9 104.2 469.8 103.2Q468.7 102.1 467.2 101.4Q465.6 100.8 462.7 99.9Q458.4 98.6 455.8 97.3Q453.1 96.0 451.2 93.4Q449.3 90.9 449.3 86.8Q449.3 80.7 453.7 77.3Q458.1 73.9 465.1 73.9Q472.3 73.9 476.7 77.3Q481.1 80.7 481.4 86.9H470.0Q469.9 84.8 468.4 83.6Q467.0 82.3 464.8 82.3Q462.8 82.3 461.7 83.4Q460.5 84.4 460.5 86.3Q460.5 88.4 462.5 89.6Q464.5 90.8 468.7 92.1Q472.9 93.6 475.5 94.9Q478.2 96.2 480.1 98.7Q482.0 101.1 482.0 105.0Q482.0 108.8 480.1 111.8Q478.2 114.8 474.6 116.6Q471.0 118.4 466.1 118.4Q461.4 118.4 457.6 116.9Q453.8 115.3 451.5 112.3Q449.3 109.3 449.1 105.0Z M507.8 109.0V118.0H502.4Q496.6 118.0 493.4 115.2Q490.2 112.4 490.2 106.0V92.2H486.0V83.4H490.2V75.0H500.8V83.4H507.7V92.2H500.8V106.1Q500.8 107.6 501.5 108.3Q502.3 109.0 504.0 109.0Z M511.6 100.7Q511.6 95.4 513.9 91.3Q516.3 87.2 520.4 85.1Q524.5 82.9 529.6 82.9Q534.6 82.9 538.7 85.1Q542.8 87.2 545.2 91.3Q547.5 95.4 547.5 100.7Q547.5 106.0 545.2 110.1Q542.8 114.2 538.6 116.3Q534.5 118.5 529.4 118.5Q524.4 118.5 520.3 116.3Q516.2 114.2 513.9 110.1Q511.6 106.1 511.6 100.7ZM536.8 100.7Q536.8 96.5 534.7 94.3Q532.6 92.1 529.6 92.1Q526.5 92.1 524.4 94.3Q522.4 96.5 522.4 100.7Q522.4 104.9 524.4 107.1Q526.4 109.3 529.4 109.3Q532.5 109.3 534.6 107.1Q536.8 104.9 536.8 100.7Z M574.6 83.0V94.3H571.7Q567.8 94.3 565.8 96.0Q563.8 97.7 563.8 101.9V118.0H553.2V83.4H563.8V89.2Q565.6 86.3 568.4 84.7Q571.2 83.0 574.6 83.0Z M612.1 103.2H588.1Q588.4 106.5 590.2 108.2Q592.1 109.9 594.7 109.9Q598.7 109.9 600.2 106.5H611.5Q610.7 109.9 608.4 112.7Q606.1 115.4 602.7 116.9Q599.3 118.5 595.1 118.5Q590.0 118.5 586.0 116.3Q582.1 114.2 579.8 110.1Q577.6 106.1 577.6 100.7Q577.6 95.3 579.8 91.3Q582.0 87.2 586.0 85.1Q589.9 82.9 595.1 82.9Q600.1 82.9 604.0 85.0Q607.9 87.1 610.1 91.0Q612.3 94.9 612.3 100.1Q612.3 101.6 612.1 103.2ZM601.5 97.4Q601.5 94.6 599.6 93.0Q597.8 91.4 595.0 91.4Q592.3 91.4 590.5 93.0Q588.6 94.5 588.2 97.4Z\" fill=\"#FFFFFF\"/><path d=\"M653.5 74.0Q661.2 74.0 666.8 78.1Q672.3 82.2 674.1 89.2H662.5Q661.2 86.5 658.8 85.1Q656.4 83.7 653.4 83.7Q648.5 83.7 645.4 87.1Q642.4 90.5 642.4 96.2Q642.4 101.9 645.4 105.3Q648.5 108.7 653.4 108.7Q656.4 108.7 658.8 107.3Q661.2 105.8 662.5 103.1H674.1Q672.3 110.2 666.8 114.2Q661.2 118.3 653.5 118.3Q647.2 118.3 642.2 115.5Q637.2 112.7 634.4 107.6Q631.6 102.6 631.6 96.2Q631.6 89.7 634.4 84.7Q637.2 79.6 642.2 76.8Q647.2 74.0 653.5 74.0Z M679.7 74.1Q679.7 71.6 681.4 70.0Q683.2 68.3 686.0 68.3Q688.7 68.3 690.5 70.0Q692.2 71.6 692.2 74.1Q692.2 76.5 690.5 78.2Q688.7 79.8 686.0 79.8Q683.2 79.8 681.4 78.2Q679.7 76.5 679.7 74.1ZM691.3 83.4V118.0H680.7V83.4Z M720.4 83.0V94.3H717.5Q713.5 94.3 711.5 96.0Q709.5 97.7 709.5 101.9V118.0H698.9V83.4H709.5V89.2Q711.4 86.3 714.2 84.7Q717.0 83.0 720.4 83.0Z M740.7 82.9Q747.2 82.9 751.6 86.3Q756.0 89.7 757.3 95.9H746.1Q744.6 92.0 740.5 92.0Q737.6 92.0 735.9 94.2Q734.2 96.5 734.2 100.7Q734.2 104.9 735.9 107.2Q737.6 109.4 740.5 109.4Q744.6 109.4 746.1 105.5H757.3Q756.0 111.6 751.6 115.0Q747.2 118.5 740.7 118.5Q735.6 118.5 731.7 116.3Q727.8 114.2 725.6 110.1Q723.4 106.1 723.4 100.7Q723.4 95.3 725.6 91.3Q727.8 87.2 731.7 85.1Q735.6 82.9 740.7 82.9Z M773.6 72.1V118.0H763.0V72.1Z M813.7 103.2H789.7Q790.0 106.5 791.8 108.2Q793.6 109.9 796.3 109.9Q800.3 109.9 801.8 106.5H813.1Q812.2 109.9 810.0 112.7Q807.7 115.4 804.3 116.9Q800.9 118.5 796.7 118.5Q791.6 118.5 787.6 116.3Q783.6 114.2 781.4 110.1Q779.2 106.1 779.2 100.7Q779.2 95.3 781.4 91.3Q783.6 87.2 787.5 85.1Q791.5 82.9 796.7 82.9Q801.7 82.9 805.6 85.0Q809.5 87.1 811.7 91.0Q813.9 94.9 813.9 100.1Q813.9 101.6 813.7 103.2ZM803.0 97.4Q803.0 94.6 801.2 93.0Q799.3 91.4 796.5 91.4Q793.9 91.4 792.0 93.0Q790.2 94.5 789.8 97.4Z\" fill=\"#2EDDA2\"/><path d=\"M270.0 150.5H264.7L263.9 153.0H260.3L265.4 139.0H269.4L274.4 153.0H270.8ZM269.1 147.9 267.4 142.7 265.6 147.9Z M289.1 139.0V141.7H283.4V144.7H287.7V147.3H283.4V153.0H280.0V139.0Z M304.1 139.0V141.7H298.3V144.7H302.6V147.3H298.3V153.0H294.9V139.0Z M313.3 139.0V153.0H309.9V139.0Z M323.2 150.4H327.7V153.0H319.8V139.0H323.2Z M336.7 139.0V153.0H333.3V139.0Z M351.9 150.5H346.7L345.9 153.0H342.3L347.4 139.0H351.3L356.4 153.0H352.8ZM351.1 147.9 349.3 142.7 347.6 147.9Z M372.0 139.0V141.7H368.3V153.0H364.9V141.7H361.2V139.0Z M381.2 141.7V144.5H385.8V147.2H381.2V150.3H386.4V153.0H377.8V139.0H386.4V141.7Z M406.4 148.0H404.2V153.0H400.8V139.0H406.4Q408.0 139.0 409.2 139.5Q410.4 140.1 410.9 141.1Q411.5 142.2 411.5 143.5Q411.5 144.7 411.0 145.7Q410.4 146.7 409.2 147.3Q408.1 148.0 406.4 148.0ZM408.0 143.5Q408.0 142.6 407.6 142.2Q407.1 141.7 406.1 141.7H404.2V145.2H406.1Q407.1 145.2 407.6 144.8Q408.0 144.3 408.0 143.5Z M424.5 153.0 421.5 147.7H420.7V153.0H417.3V139.0H423.0Q424.7 139.0 425.9 139.5Q427.0 140.1 427.6 141.1Q428.2 142.1 428.2 143.4Q428.2 144.8 427.4 145.9Q426.6 147.0 425.1 147.4L428.3 153.0ZM420.7 145.3H422.8Q423.8 145.3 424.2 144.8Q424.7 144.4 424.7 143.5Q424.7 142.7 424.2 142.3Q423.8 141.8 422.8 141.8H420.7Z M433.8 145.9Q433.8 143.9 434.7 142.2Q435.7 140.6 437.4 139.7Q439.0 138.8 441.0 138.8Q443.0 138.8 444.6 139.7Q446.3 140.6 447.2 142.2Q448.2 143.9 448.2 145.9Q448.2 148.0 447.2 149.7Q446.2 151.3 444.6 152.2Q443.0 153.1 441.0 153.1Q439.0 153.1 437.4 152.2Q435.7 151.3 434.7 149.7Q433.8 148.0 433.8 145.9ZM444.7 145.9Q444.7 144.1 443.7 143.0Q442.7 141.9 441.0 141.9Q439.3 141.9 438.3 143.0Q437.3 144.1 437.3 145.9Q437.3 147.8 438.3 148.9Q439.3 150.0 441.0 150.0Q442.7 150.0 443.7 148.9Q444.7 147.8 444.7 145.9Z M463.4 143.4Q463.0 142.7 462.3 142.3Q461.6 142.0 460.6 142.0Q459.0 142.0 458.0 143.1Q457.0 144.1 457.0 146.0Q457.0 147.9 458.0 149.0Q459.1 150.1 460.9 150.1Q462.2 150.1 463.0 149.4Q463.9 148.8 464.3 147.6H460.0V145.1H467.4V148.3Q467.0 149.5 466.1 150.6Q465.2 151.7 463.8 152.4Q462.4 153.1 460.6 153.1Q458.6 153.1 456.9 152.2Q455.3 151.3 454.4 149.7Q453.5 148.0 453.5 146.0Q453.5 143.9 454.4 142.2Q455.3 140.6 456.9 139.7Q458.5 138.8 460.6 138.8Q463.1 138.8 464.9 140.0Q466.6 141.2 467.2 143.4Z M480.5 153.0 477.5 147.7H476.7V153.0H473.3V139.0H479.0Q480.7 139.0 481.9 139.5Q483.0 140.1 483.6 141.1Q484.2 142.1 484.2 143.4Q484.2 144.8 483.4 145.9Q482.6 147.0 481.1 147.4L484.3 153.0ZM476.7 145.3H478.8Q479.8 145.3 480.3 144.8Q480.7 144.4 480.7 143.5Q480.7 142.7 480.3 142.3Q479.8 141.8 478.8 141.8H476.7Z M499.1 150.5H493.8L493.0 153.0H489.4L494.5 139.0H498.5L503.5 153.0H499.9ZM498.2 147.9 496.5 142.7 494.7 147.9Z M525.0 139.0V153.0H521.6V144.6L518.4 153.0H515.7L512.5 144.6V153.0H509.1V139.0H513.1L517.1 148.7L521.0 139.0Z\" fill=\"#9FB8AF\"/></svg>" }, scout: { w: 803, h: 220, svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 803 220\"><defs><linearGradient id=\"tile\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\"><stop offset=\"0%\" stop-color=\"#FFD88A\"/><stop offset=\"100%\" stop-color=\"#F0A21A\"/></linearGradient><radialGradient id=\"dot\" cx=\"35%\" cy=\"35%\" r=\"75%\"><stop offset=\"0%\" stop-color=\"#2EDDA2\"/><stop offset=\"100%\" stop-color=\"#008558\"/></radialGradient><mask id=\"halo\" maskUnits=\"userSpaceOnUse\" x=\"-40\" y=\"-40\" width=\"300\" height=\"300\"><rect x=\"-40\" y=\"-40\" width=\"300\" height=\"300\" fill=\"#fff\"/><circle cx=\"141.02\" cy=\"77.00\" r=\"19.5\" fill=\"#000\"/></mask></defs><rect width=\"220\" height=\"220\" rx=\"48\" fill=\"url(#tile)\"/><g mask=\"url(#halo)\"><path d=\"M 184.44 100.86 A 75 75 0 1 1 126.87 36.92\" fill=\"none\" stroke=\"#0B3B2B\" stroke-width=\"5.5\" stroke-linecap=\"round\"/><path d=\"M 166.45 102.07 A 57 57 0 1 1 121.85 54.25\" fill=\"none\" stroke=\"#0B3B2B\" stroke-width=\"15\" stroke-linecap=\"round\"/><path d=\"M79.98 81.00 L113.73 81.17 L122.89 136.46 L123.74 81.17 L140.02 81.17 L140.02 138.66 L119.50 139.34 L105.93 138.15 L98.13 84.73 L96.77 83.37 L96.60 138.83 L79.98 138.66Z\" fill=\"#0B3B2B\"/></g><path d=\"M141.02 77.00L150 36\" stroke=\"#0B3B2B\" stroke-width=\"4.6\" stroke-linecap=\"round\"/><path d=\"M141.02 77.00L189 80\" stroke=\"#0B3B2B\" stroke-width=\"4.6\" stroke-linecap=\"round\"/><circle cx=\"150\" cy=\"36\" r=\"8.5\" fill=\"#0B3B2B\"/><circle cx=\"189\" cy=\"80\" r=\"7.5\" fill=\"#0B3B2B\"/><circle cx=\"141.02\" cy=\"77.00\" r=\"15\" fill=\"url(#dot)\"/><path d=\"M300.8 118.0H290.2L272.4 91.2V118.0H261.8V74.5H272.4L290.2 101.4V74.5H300.8Z M340.9 103.2H316.9Q317.1 106.5 319.0 108.2Q320.8 109.9 323.5 109.9Q327.4 109.9 329.0 106.5H340.3Q339.4 109.9 337.1 112.7Q334.9 115.4 331.5 116.9Q328.1 118.5 323.8 118.5Q318.8 118.5 314.8 116.3Q310.8 114.2 308.6 110.1Q306.4 106.1 306.4 100.7Q306.4 95.3 308.6 91.3Q310.8 87.2 314.7 85.1Q318.7 82.9 323.8 82.9Q328.9 82.9 332.8 85.0Q336.7 87.1 338.9 91.0Q341.1 94.9 341.1 100.1Q341.1 101.6 340.9 103.2ZM330.2 97.4Q330.2 94.6 328.4 93.0Q326.5 91.4 323.7 91.4Q321.1 91.4 319.2 93.0Q317.4 94.5 317.0 97.4Z M367.1 118.0 360.5 108.4 354.9 118.0H343.4L354.8 100.3L343.1 83.4H355.0L361.7 93.0L367.2 83.4H378.7L367.1 100.8L379.0 118.0Z M402.4 109.0V118.0H397.0Q391.2 118.0 388.0 115.2Q384.8 112.4 384.8 106.0V92.2H380.6V83.4H384.8V75.0H395.4V83.4H402.3V92.2H395.4V106.1Q395.4 107.6 396.1 108.3Q396.9 109.0 398.6 109.0Z M421.4 82.9Q425.1 82.9 427.8 84.4Q430.6 85.9 432.1 88.3V83.4H442.7V118.0H432.1V113.1Q430.5 115.5 427.8 117.0Q425.0 118.5 421.4 118.5Q417.2 118.5 413.7 116.3Q410.2 114.1 408.2 110.0Q406.2 106.0 406.2 100.6Q406.2 95.3 408.2 91.3Q410.2 87.2 413.7 85.1Q417.2 82.9 421.4 82.9ZM424.5 92.1Q421.4 92.1 419.2 94.4Q417.0 96.7 417.0 100.6Q417.0 104.6 419.2 106.9Q421.4 109.3 424.5 109.3Q427.7 109.3 429.9 107.0Q432.1 104.7 432.1 100.7Q432.1 96.7 429.9 94.4Q427.7 92.1 424.5 92.1Z M449.1 105.0H460.4Q460.7 107.4 462.1 108.7Q463.5 109.9 465.8 109.9Q468.2 109.9 469.5 108.9Q470.9 107.8 470.9 105.8Q470.9 104.2 469.8 103.2Q468.7 102.1 467.2 101.4Q465.6 100.8 462.7 99.9Q458.4 98.6 455.8 97.3Q453.1 96.0 451.2 93.4Q449.3 90.9 449.3 86.8Q449.3 80.7 453.7 77.3Q458.1 73.9 465.1 73.9Q472.3 73.9 476.7 77.3Q481.1 80.7 481.4 86.9H470.0Q469.9 84.8 468.4 83.6Q467.0 82.3 464.8 82.3Q462.8 82.3 461.7 83.4Q460.5 84.4 460.5 86.3Q460.5 88.4 462.5 89.6Q464.5 90.8 468.7 92.1Q472.9 93.6 475.5 94.9Q478.2 96.2 480.1 98.7Q482.0 101.1 482.0 105.0Q482.0 108.8 480.1 111.8Q478.2 114.8 474.6 116.6Q471.0 118.4 466.1 118.4Q461.4 118.4 457.6 116.9Q453.8 115.3 451.5 112.3Q449.3 109.3 449.1 105.0Z M507.8 109.0V118.0H502.4Q496.6 118.0 493.4 115.2Q490.2 112.4 490.2 106.0V92.2H486.0V83.4H490.2V75.0H500.8V83.4H507.7V92.2H500.8V106.1Q500.8 107.6 501.5 108.3Q502.3 109.0 504.0 109.0Z M511.6 100.7Q511.6 95.4 513.9 91.3Q516.3 87.2 520.4 85.1Q524.5 82.9 529.6 82.9Q534.6 82.9 538.7 85.1Q542.8 87.2 545.2 91.3Q547.5 95.4 547.5 100.7Q547.5 106.0 545.2 110.1Q542.8 114.2 538.6 116.3Q534.5 118.5 529.4 118.5Q524.4 118.5 520.3 116.3Q516.2 114.2 513.9 110.1Q511.6 106.1 511.6 100.7ZM536.8 100.7Q536.8 96.5 534.7 94.3Q532.6 92.1 529.6 92.1Q526.5 92.1 524.4 94.3Q522.4 96.5 522.4 100.7Q522.4 104.9 524.4 107.1Q526.4 109.3 529.4 109.3Q532.5 109.3 534.6 107.1Q536.8 104.9 536.8 100.7Z M574.6 83.0V94.3H571.7Q567.8 94.3 565.8 96.0Q563.8 97.7 563.8 101.9V118.0H553.2V83.4H563.8V89.2Q565.6 86.3 568.4 84.7Q571.2 83.0 574.6 83.0Z M612.1 103.2H588.1Q588.4 106.5 590.2 108.2Q592.1 109.9 594.7 109.9Q598.7 109.9 600.2 106.5H611.5Q610.7 109.9 608.4 112.7Q606.1 115.4 602.7 116.9Q599.3 118.5 595.1 118.5Q590.0 118.5 586.0 116.3Q582.1 114.2 579.8 110.1Q577.6 106.1 577.6 100.7Q577.6 95.3 579.8 91.3Q582.0 87.2 586.0 85.1Q589.9 82.9 595.1 82.9Q600.1 82.9 604.0 85.0Q607.9 87.1 610.1 91.0Q612.3 94.9 612.3 100.1Q612.3 101.6 612.1 103.2ZM601.5 97.4Q601.5 94.6 599.6 93.0Q597.8 91.4 595.0 91.4Q592.3 91.4 590.5 93.0Q588.6 94.5 588.2 97.4Z\" fill=\"#FFFFFF\"/><path d=\"M653.5 74.0Q661.2 74.0 666.8 78.1Q672.3 82.2 674.1 89.2H662.5Q661.2 86.5 658.8 85.1Q656.4 83.7 653.4 83.7Q648.5 83.7 645.4 87.1Q642.4 90.5 642.4 96.2Q642.4 101.9 645.4 105.3Q648.5 108.7 653.4 108.7Q656.4 108.7 658.8 107.3Q661.2 105.8 662.5 103.1H674.1Q672.3 110.2 666.8 114.2Q661.2 118.3 653.5 118.3Q647.2 118.3 642.2 115.5Q637.2 112.7 634.4 107.6Q631.6 102.6 631.6 96.2Q631.6 89.7 634.4 84.7Q637.2 79.6 642.2 76.8Q647.2 74.0 653.5 74.0Z M702.1 83.0V94.3H699.2Q695.2 94.3 693.2 96.0Q691.3 97.7 691.3 101.9V118.0H680.7V83.4H691.3V89.2Q693.1 86.3 695.9 84.7Q698.7 83.0 702.1 83.0Z M739.6 103.2H715.6Q715.9 106.5 717.7 108.2Q719.5 109.9 722.2 109.9Q726.2 109.9 727.7 106.5H739.0Q738.1 109.9 735.9 112.7Q733.6 115.4 730.2 116.9Q726.8 118.5 722.6 118.5Q717.5 118.5 713.5 116.3Q709.5 114.2 707.3 110.1Q705.1 106.1 705.1 100.7Q705.1 95.3 707.3 91.3Q709.5 87.2 713.5 85.1Q717.4 82.9 722.6 82.9Q727.6 82.9 731.5 85.0Q735.4 87.1 737.6 91.0Q739.8 94.9 739.8 100.1Q739.8 101.6 739.6 103.2ZM729.0 97.4Q729.0 94.6 727.1 93.0Q725.2 91.4 722.4 91.4Q719.8 91.4 717.9 93.0Q716.1 94.5 715.7 97.4Z M795.0 83.4 785.7 118.0H774.0L768.5 95.6L762.9 118.0H751.2L741.8 83.4H752.4L757.3 108.1L763.1 83.4H774.3L780.2 108.0L785.1 83.4Z\" fill=\"#FFB038\"/><path d=\"M270.4 139.0V141.7H264.7V144.7H268.9V147.3H264.7V153.0H261.2V139.0Z M279.6 139.0V153.0H276.2V139.0Z M289.5 141.7V144.5H294.1V147.2H289.5V150.3H294.7V153.0H286.1V139.0H294.7V141.7Z M304.3 150.4H308.8V153.0H300.9V139.0H304.3Z M327.1 146.0Q327.1 148.0 326.1 149.6Q325.2 151.2 323.6 152.1Q321.9 153.0 319.7 153.0H314.4V139.0H319.7Q321.9 139.0 323.6 139.8Q325.2 140.7 326.1 142.3Q327.1 143.9 327.1 146.0ZM323.6 146.0Q323.6 144.0 322.5 143.0Q321.4 141.9 319.5 141.9H317.9V150.0H319.5Q321.4 150.0 322.5 149.0Q323.6 147.9 323.6 146.0Z M351.3 139.0V141.7H347.6V153.0H344.2V141.7H340.5V139.0Z M360.5 141.7V144.5H365.0V147.2H360.5V150.3H365.6V153.0H357.0V139.0H365.6V141.7Z M380.6 150.5H375.4L374.5 153.0H370.9L376.0 139.0H380.0L385.1 153.0H381.4ZM379.7 147.9 378.0 142.7 376.3 147.9Z M406.5 139.0V153.0H403.1V144.6L399.9 153.0H397.2L394.0 144.6V153.0H390.6V139.0H394.6L398.6 148.7L402.5 139.0Z\" fill=\"#9FB8AF\"/></svg>" } };

    // ---------------------------------------------------------------- messages
    function messages(ctx) {
        const { link, code, program } = ctx; const me = ctx.firstName || 'a friend';
        const trial = ctx.rules?.trialDays || 7;
        const base = [
            { id: 'status', title: 'WhatsApp status', when: 'Post once a week', text: `Do you sell something? Open your own online shop on NextaStore, free for ${trial} days, and share one link with all your customers.\n${link}` },
            { id: 'direct', title: 'Message a shop owner', when: 'After you chat in person or by phone', text: `Hello, it is ${me}. I think NextaStore would suit your business: your products and prices in one link that your customers can open and order from. It is free for ${trial} days, no card. Start here: ${link}` },
            { id: 'group', title: 'For a business group', when: 'Posting in a trader or community group', text: `Traders: if you are tired of resending photos and prices, NextaStore gives you one shop link for everything. Free for ${trial} days. Open yours: ${link}  (use code ${code})` }
        ];
        if (program !== 'scout') return base;
        return [
            { id: 'after_visit', title: 'After the first visit', when: 'The same day you meet them', text: `Hello, it was good meeting you today. Here is the link to open your NextaStore, free for ${trial} days: ${link}  Use my code ${code} so I can help you set up. I will pass by again soon.` },
            { id: 'no_products', title: 'Signed up, no products yet', when: 'Account exists but the shop is empty', text: `Hello, your NextaStore account is ready. Shall we add your first three products today? It takes about 10 minutes and I can come to you.` },
            { id: 'trial_ending', title: 'Free trial ending', when: 'About 2 days before the trial ends', text: `Hello, your free week ends in 2 days. To keep your shop visible, choose a Seller Pass on the Seller Pass page and pay with MTN or Airtel. I can sit with you to do it if you like.` },
            { id: 'payment_wait', title: 'Payment sent, waiting', when: 'They paid but it is not approved yet', text: `Hello, I saw you sent your payment. Please check the transaction ID you typed matches the one in your MTN or Airtel SMS exactly, so it is approved quickly.` },
            ...base
        ];
    }

    // ---------------------------------------------------------------- pitch
    function pitch(ctx) {
        const r = ctx.rules || {}; const trial = r.trialDays || 7; const price = r.passPricePerMonth || 20000;
        return {
            opening: [
                'Start with their problem, not our product: "Do customers ask you for prices on WhatsApp, and you type the same thing again and again?"',
                'One sentence on what we are: "NextaStore gives your shop its own online store with its own link. Customers see your products and prices, message you and order."',
                `Remove the fear: "It is free for ${trial} days. No card. You pay only if you like it, by MTN or Airtel."`,
                'Ask for ten minutes now: "Can I show you on your phone? We will have your first products up before I leave."'
            ],
            demo: [
                'Open the link on THEIR phone. Your code is already filled in.',
                'Create the account and verify the email together.',
                'Store name, a short description, area and phone number.',
                'Add three real products with their own photos and prices. Three is the magic number: stores with three products pay far more often.',
                'Launch. Show them their store link and send it to their own WhatsApp.',
                'Tell them: "Put this link in your WhatsApp status today. That is your shop window."'
            ],
            objections: [
                { q: '"I already sell on WhatsApp."', a: 'Keep that. This puts every product and price in one link, so you stop re-sending photos. Customers can order without waiting for you to reply.' },
                { q: '"Is it free?"', a: `The first ${trial} days are free. After that a Seller Pass is ${ugx(price)} a month, and you can pay for several months at once.` },
                { q: '"I do not trust paying online."', a: 'You pay by MTN or Airtel to NextaStore\'s official number and send the transaction ID. A person confirms it. You are never asked for a PIN.' },
                { q: '"I do not have time."', a: 'That is why I am here. We will do it now, together, in ten minutes.' },
                { q: '"Nobody will find me."', a: 'Shoppers browse the marketplace, and you also get your own link to share. A Seller Pass badge gives you an edge, and 6 months earns the Verified Seller badge.' },
                { q: '"Let me think."', a: 'Of course. Can I log your shop so no one else calls you, and come back on Thursday? (Then actually come back, and log the visit.)' }
            ]
        };
    }

    // ---------------------------------------------------------------- invite card
    function wrap(text, max) {
        const words = String(text).split(/\s+/); const lines = []; let cur = '';
        for (const w of words) { if ((cur + ' ' + w).trim().length > max) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
        if (cur) lines.push(cur); return lines;
    }
    /** 1080 x 1350 portrait card: sized for a WhatsApp status. System fonts only, so it never waits on a download. */
    function cardSvg(ctx) {
        const W = 1080, H = 1350; const trial = ctx.rules?.trialDays || 7;
        const scout = ctx.program === 'scout'; const brand = LOCKUP[scout ? 'scout' : 'circle'];
        const lockH = 112, lockW = Math.round(lockH * brand.w / brand.h);
        const accent = scout ? '#FFD88A' : '#D6F5E8';
        const who = ctx.firstName ? `Invited by ${ctx.firstName}` : 'You are invited';
        const headline = wrap('Open your shop on NextaStore', 16);
        const yHead = 340, lineGap = 100;
        const yAfter = yHead + (headline.length - 1) * lineGap;   // baseline of the last headline line
        const qrTop = yAfter + 170;
        let qr = '', qrBottom = yAfter + 100;
        if (root.NextaQR) {
            try {
                const q = root.NextaQR.encode(ctx.link); const cell = Math.max(4, Math.floor(380 / (q.size + 4))); const dim = (q.size + 4) * cell;
                let d = ''; for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) d += `M${(x + 2) * cell},${(y + 2) * cell}h${cell}v${cell}h-${cell}z`;
                qr = `<g transform="translate(${(W - dim) / 2},${qrTop})"><rect width="${dim}" height="${dim}" rx="22" fill="#fff"/><path d="${d}" fill="#0b3b2b"/></g>`;
                qrBottom = qrTop + dim;
            } catch (err) { qr = ''; }
        }
        const y0 = qr ? qrBottom + 62 : yAfter + 190;          // "Scan, or use my code"
        const boxY = y0 + 26;                                   // the code box (height 100)
        const g = scout ? ['#062a1d', '#0b3b2b', '#17503c'] : ['#0b3b2b', '#0f5a41', '#138a62'];
        return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Poppins, Segoe UI, Roboto, Helvetica, Arial, sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g[0]}"/><stop offset="0.6" stop-color="${g[1]}"/><stop offset="1" stop-color="${g[2]}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<circle cx="940" cy="170" r="260" fill="none" stroke="${scout ? '#ffb038' : '#2edda2'}" stroke-opacity="0.28" stroke-width="3"/><circle cx="940" cy="170" r="390" fill="none" stroke="${scout ? '#ffb038' : '#2edda2'}" stroke-opacity="0.16" stroke-width="3"/><circle cx="120" cy="1230" r="300" fill="#ffffff" opacity="0.05"/>
<image x="80" y="52" width="${lockW}" height="${lockH}" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(brand.svg)}" xlink:href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(brand.svg)}"/>
<text x="90" y="232" font-size="30" fill="#ffffff" opacity="0.85">${esc(who)}</text>
${headline.map((l, i) => `<text x="90" y="${yHead + i * lineGap}" font-size="92" font-weight="800" fill="#ffffff">${esc(l)}</text>`).join('')}
<text x="90" y="${yAfter + 66}" font-size="40" fill="${accent}">Free for ${trial} days. No card needed.</text>
<text x="90" y="${yAfter + 120}" font-size="32" fill="#ffffff" opacity="0.85">One link for all your products and prices.</text>
${qr}
<text x="${W / 2}" y="${y0}" text-anchor="middle" font-size="38" fill="${accent}">${qr ? 'Scan, or use my code' : 'Use my code'}</text>
<rect x="${W / 2 - 300}" y="${boxY}" width="600" height="100" rx="24" fill="#ffffff" opacity="0.16"/>
<text x="${W / 2}" y="${boxY + 69}" text-anchor="middle" font-size="58" font-weight="800" fill="#ffffff" letter-spacing="4" font-family="Consolas, Menlo, monospace">${esc(ctx.code)}</text>
<text x="${W / 2}" y="${H - 60}" text-anchor="middle" font-size="28" fill="#ffffff" opacity="0.75">${esc(String(ctx.link).replace(/^https?:\/\//, ''))}</text>
</svg>`;
    }
    function cardBlob(ctx) {
        return new Promise((resolve, reject) => {
            const svg = cardSvg(ctx);
            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1350;
                    canvas.getContext('2d').drawImage(img, 0, 0, 1080, 1350);
                    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not make the image.'))), 'image/png');
                } catch (err) { reject(err); }
            };
            img.onerror = () => reject(new Error('Could not make the image.'));
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        });
    }
    async function shareOrDownload(ctx) {
        const blob = await cardBlob(ctx);
        const file = new File([blob], `nextastore-${String(ctx.code).toLowerCase()}.png`, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file], text: ctx.link }); return 'shared'; } catch (err) { if (err && err.name === 'AbortError') return 'cancelled'; }
        }
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000); return 'downloaded';
    }

    // ---------------------------------------------------------------- UI
    async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch (err) { return false; } }
    function mount(el, ctx, toast = () => {}) {
        const list = messages(ctx);
        const p = ctx.program === 'scout' ? pitch(ctx) : null;
        el.innerHTML = `<h2>Share studio</h2>
            <p class="gp-muted">Everything you need to reach people, ready to send. Your code and link are already in each one.</p>
            <div class="gp-studio">
                <div class="gp-card-preview" id="gpCardPreview" aria-label="Your invite card">${cardSvg(ctx)}</div>
                <div class="gp-studio-actions">
                    <button class="gp-btn is-primary" id="gpCardShare"><i class="fas fa-share-nodes" aria-hidden="true"></i> Share my invite card</button>
                    <button class="gp-btn" id="gpCardSave"><i class="fas fa-download" aria-hidden="true"></i> Save as picture</button>
                    <p class="gp-muted">Post the picture on your WhatsApp status. Anyone can scan the QR code or type your code. The QR works even without internet on your phone.</p>
                </div>
            </div>
            <h3 style="margin-top:18px">Messages</h3>
            ${list.map((m) => `<details class="gp-acc"><summary><b>${esc(m.title)}</b> <span class="gp-muted">· ${esc(m.when)}</span></summary>
                <pre class="gp-msg">${esc(m.text)}</pre>
                <div class="gp-row"><button class="gp-btn is-small" data-copy="${esc(m.id)}"><i class="fas fa-copy"></i> Copy</button>
                <a class="gp-btn is-small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(m.text)}"><i class="fab fa-whatsapp"></i> WhatsApp</a></div></details>`).join('')}
            ${p ? `<h3 style="margin-top:18px">Pitch kit</h3>
                <details class="gp-acc"><summary><b>The 60-second pitch</b></summary><ol class="gp-steps">${p.opening.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
                <details class="gp-acc"><summary><b>The 5-minute demo</b> <span class="gp-muted">· on their phone</span></summary><ol class="gp-steps">${p.demo.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
                <details class="gp-acc"><summary><b>When they say no (or "later")</b></summary>${p.objections.map((o) => `<p class="gp-reason"><b>${esc(o.q)}</b><br>${esc(o.a)}</p>`).join('')}</details>` : ''}`;
        el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
            const m = list.find((x) => x.id === b.dataset.copy); toast((await copy(m.text)) ? 'Copied. Paste it into WhatsApp.' : 'Press and hold the text to copy it.');
        }));
        const run = (btn, fn) => btn.addEventListener('click', async () => { btn.disabled = true; try { const r = await fn(); if (r === 'downloaded') toast('Saved to your phone. Add it to your status.'); } catch (err) { toast(err.message || 'Something went wrong.'); } finally { btn.disabled = false; } });
        run(el.querySelector('#gpCardShare'), () => shareOrDownload(ctx));
        run(el.querySelector('#gpCardSave'), async () => { const blob = await cardBlob(ctx); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nextastore-${String(ctx.code).toLowerCase()}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Saved to your phone.'); return 'saved'; });
    }

    root.GrowthKit = { messages, pitch, cardSvg, cardBlob, shareOrDownload, mount };
    if (typeof module !== 'undefined' && module.exports) module.exports = root.GrowthKit;
})(typeof window !== 'undefined' ? window : globalThis);
