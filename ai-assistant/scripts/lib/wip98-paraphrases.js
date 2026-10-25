// WIP 98 Item 3: CORRECT natural model answers that word the guides' facts differently ("7-day free trial" / "free trial of 7 days", "refund" / "money back",
// numbers as words or digits, UGX 20,000 / 20k). Every one must come back through the pipeline UNCHANGED (a page link may be appended).
// WRONG answers (a changed figure or an invented promise) must NOT come back unchanged. Facts: src/knowledge/90-project-facts.generated.md.
module.exports.CORRECT = [
 // single-part
 ['how long is the free trial', 'Every new store gets a free trial that lasts 7 days.'],
 ['how long is the free trial', 'You get seven days free before you have to pay.'],
 ['how long is the free trial', 'New stores start with a 7-day free trial.'],
 ['how much is seller pass', 'Seller Pass is 20k shillings a month.'],
 ['how much is seller pass', 'It costs 20,000 shillings per month of coverage.'],
 ['how much is seller pass', 'Seller Pass costs twenty thousand shillings every month.'],
 ['is seller pass refundable', "No, Seller Pass payments can't be refunded."],
 ['can i get my seller pass money back', 'Sorry, there is no money back on a Seller Pass payment, because those payments are not refundable.'],
 ['how long should my password be', 'Use a password with at least eight characters.'],
 ['how many months can i buy at a time', 'You can buy 1, 3, 6, 12 or 24 months of coverage at a time.'],
 ['how many months can i buy at a time', 'Coverage comes in blocks of one, three, six, twelve or twenty-four months.'],
 ['how long do i have to cancel an order', 'You can cancel your order within 30 minutes of placing it, as long as it is still pending or processing.'],
 ['how many times can i cancel orders', 'A buyer can cancel up to three orders in any 30 days.'],
 ['when do i get the verified seller badge', 'You earn Verified Seller after 6 months of paid coverage in a row.'],
 ['how many steps to open a store', 'Opening a store takes four steps: Store Basics, Branding, Payments and then Review & Launch.'],
 ['what are the order statuses', 'An order can be pending, processing, shipped, delivered or cancelled.'],
 ['how do i contact support', 'You can email support@nextawillstechnologies.com for help.'],
 ['does delivery need an address', 'Delivery needs a delivery address, but pickup does not.'],
 // two-part
 ['how much is seller pass and is it refundable', 'Seller Pass costs UGX 20,000 per month, and those payments are not refundable.'],
 ['how much is seller pass and is it refundable', "It's 20k a month, and you can't get your money back on a payment."],
 ['how long is the free trial and how much is it after', 'The free trial is 7 days, then it is 20,000 shillings a month.'],
 ['how long can i cancel an order and how many times can i do it', 'You can cancel within 30 minutes, and up to 3 times in 30 days.'],
 ['how many months can i buy and how much is 3 months', 'You can buy 1, 3, 6, 12 or 24 months at a time. Three months comes to UGX 60,000.'],
 ['how long is the free trial and is seller pass refundable', 'You get a 7-day free trial, and Seller Pass payments are not refundable.'],
 ['what are the order statuses and can a seller change a delivered order', 'Orders are pending, processing, shipped, delivered or cancelled, and a delivered order is final and cannot be changed.'],
];
// Wrong on purpose: each changes a figure or invents a promise. None may reach the visitor as written.
module.exports.WRONG = [
 ['how much is seller pass', 'Seller Pass costs UGX 25,000 per month.'],
 ['how long is the free trial', 'Every new store gets a 14-day free trial.'],
 ['is seller pass refundable', 'Yes, Seller Pass payments are refundable within 7 days.'],
 ['how long should my password be', 'A password must be at least 12 characters.'],
 ['how long do i have to cancel an order', 'You can cancel your order within 60 minutes of placing it.'],
 ['how much is seller pass and is it refundable', 'Seller Pass is 20k a month and you get your money back if you cancel.'],
];
