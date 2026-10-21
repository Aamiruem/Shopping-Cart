"""Labelled example tickets for the support classifier, plus reply templates per category.

Add real, anonymised tickets here over time - the classifier retrains from this list on start-up.
"""

CATEGORY_LABELS = {
    "delivery": "Delivery & tracking",
    "returns": "Returns & refunds",
    "payment": "Payments & billing",
    "product": "Product quality",
    "account": "Account & login",
    "order_change": "Order changes & cancellation",
}

TRAINING_TICKETS = [
    # delivery
    ("My order has not arrived yet and it was supposed to come yesterday", "delivery"),
    ("Where is my package? Tracking has not updated for 4 days", "delivery"),
    ("Delivery is delayed again, when will I receive my parcel", "delivery"),
    ("The courier marked it delivered but I never received the package", "delivery"),
    ("Can you tell me the expected delivery date for my order", "delivery"),
    ("Shipment stuck in transit at the warehouse", "delivery"),
    ("Delivery boy did not come today, nobody called me", "delivery"),
    ("Package shows out for delivery since morning but not delivered", "delivery"),
    ("How long does shipping take to Bengaluru", "delivery"),
    ("Order still not shipped after 5 days", "delivery"),
    ("I want to know the status of my shipment", "delivery"),
    ("The delivery agent was rude and left the parcel outside", "delivery"),
    ("Is express delivery available for my pincode", "delivery"),
    ("Tracking link is not working for my order", "delivery"),
    ("Parcel delivered to wrong address", "delivery"),
    ("My delivery is late, I needed it for a birthday", "delivery"),
    # returns
    ("I want to return the shoes, they do not fit", "returns"),
    ("When will I get my refund for the returned item", "returns"),
    ("Refund not credited to my account after return pickup", "returns"),
    ("How do I return a product I bought last week", "returns"),
    ("Return pickup was scheduled but nobody came", "returns"),
    ("I returned the jacket two weeks ago and still no refund", "returns"),
    ("Please arrange a replacement for the item", "returns"),
    ("Can I exchange this shirt for a bigger size", "returns"),
    ("What is your return policy for electronics", "returns"),
    ("Refund amount is less than what I paid", "returns"),
    ("Return request rejected without reason", "returns"),
    ("I need to send back the dress, it looks different", "returns"),
    ("Where is my refund money", "returns"),
    ("Exchange the phone case for another colour", "returns"),
    # payment
    ("I was charged twice for the same order", "payment"),
    ("Money deducted from my bank but order not placed", "payment"),
    ("UPI payment failed but amount was debited", "payment"),
    ("My card payment keeps getting declined", "payment"),
    ("I did not receive the OTP for payment", "payment"),
    ("Please send me the GST invoice for my purchase", "payment"),
    ("EMI option is not showing at checkout", "payment"),
    ("Bank offer discount was not applied to my order", "payment"),
    ("Double charged on my credit card, need the extra amount back", "payment"),
    ("Payment pending for a long time, what should I do", "payment"),
    ("Can I pay cash on delivery for this order", "payment"),
    ("Unauthorized transaction on my account from your site", "payment"),
    ("The coupon code is not working at payment", "payment"),
    ("Invoice shows wrong amount", "payment"),
    # product
    ("The product I received is damaged", "product"),
    ("Screen of the phone is cracked on arrival", "product"),
    ("The item stopped working after two days", "product"),
    ("Received a fake product, it is not original", "product"),
    ("Quality of the fabric is very poor", "product"),
    ("Headphones have no sound in the left ear", "product"),
    ("Wrong colour product delivered", "product"),
    ("Parts are missing from the box", "product"),
    ("Does this laptop support fast charging", "product"),
    ("Is this product waterproof", "product"),
    ("The mixer makes a loud noise and smells burnt", "product"),
    ("Expiry date on the grocery item has already passed", "product"),
    ("Size chart is wrong, the shoes are too small", "product"),
    ("Warranty claim for my defective watch", "product"),
    # account
    ("I cannot log in to my account", "account"),
    ("Forgot my password and reset email not coming", "account"),
    ("How do I change my registered email address", "account"),
    ("Google sign in is not working for me", "account"),
    ("Please delete my account and personal data", "account"),
    ("Someone else is using my account", "account"),
    ("Unable to update my phone number in profile", "account"),
    ("My account got locked after many attempts", "account"),
    ("How do I become a seller on Veyra", "account"),
    ("I want to unsubscribe from promotional emails", "account"),
    ("Saved addresses disappeared from my account", "account"),
    ("Not able to verify my email", "account"),
    # order changes
    ("I want to cancel my order", "order_change"),
    ("Please change the delivery address on my order", "order_change"),
    ("Can I add another item to my existing order", "order_change"),
    ("Cancel button is not showing for my order", "order_change"),
    ("I placed the order by mistake, please cancel it", "order_change"),
    ("Change the size before the order is shipped", "order_change"),
    ("Need to update phone number for the delivery of this order", "order_change"),
    ("Order was cancelled automatically, why", "order_change"),
    ("Can I change payment method from card to cash on delivery", "order_change"),
    ("I want to modify the quantity in my order", "order_change"),
    ("How do I cancel one item from a multi item order", "order_change"),
    ("Please hold my order, I am travelling", "order_change"),
    # more phrasing variety (improves accuracy on short and informal tickets)
    ("parcel not delivered yet", "delivery"),
    ("courier says address not found but my address is correct", "delivery"),
    ("delivery was supposed to be today, still waiting", "delivery"),
    ("my shipment is late by a week", "delivery"),
    ("when will my order be dispatched", "delivery"),
    ("the order shows delivered but I did not get anything", "delivery"),
    ("need delivery before Sunday is it possible", "delivery"),
    ("how to track my order", "delivery"),
    ("refund status please", "returns"),
    ("I want my money back for the returned watch", "returns"),
    ("return window closed but product is faulty can I still return", "returns"),
    ("replacement product not received after return", "returns"),
    ("pickup agent refused to take the return", "returns"),
    ("how many days for refund to reflect in my bank", "returns"),
    ("I want to exchange the shoes for size 9", "returns"),
    ("refund was processed to wrong account", "returns"),
    ("payment failed but money gone from account", "payment"),
    ("got charged extra on my card", "payment"),
    ("cashback not received for my payment", "payment"),
    ("why was my UPI transaction declined", "payment"),
    ("need the tax invoice with GST number", "payment"),
    ("amount debited twice from my wallet", "payment"),
    ("net banking payment is not going through", "payment"),
    ("how do I pay using EMI", "payment"),
    ("item is broken inside the box", "product"),
    ("the phone heats up a lot and battery drains fast", "product"),
    ("received used product with scratches", "product"),
    ("colour of the dress is different from the photos", "product"),
    ("the product does not match the description", "product"),
    ("the laptop charger is not working", "product"),
    ("what is the warranty on this blender", "product"),
    ("the jeans are too tight, size runs small", "product"),
    ("I am not able to sign in", "account"),
    ("OTP for login not received on my email", "account"),
    ("change my account password", "account"),
    ("my account was hacked", "account"),
    ("cannot register, says email already exists", "account"),
    ("please update my name on the account", "account"),
    ("how do I link my Google account", "account"),
    ("I want to close my account permanently", "account"),
    ("cancel my order please", "order_change"),
    ("I ordered the wrong size, can I change it before shipping", "order_change"),
    ("why is my order cancelled without my permission", "order_change"),
    ("want to change delivery address to my office", "order_change"),
    ("I want to cancel one item from my order", "order_change"),
    ("can I reschedule my order delivery", "order_change"),
    ("please split my order into two shipments", "order_change"),
    ("I want to cancel and reorder with a coupon", "order_change"),
]

REPLY_TEMPLATES = {
    "delivery": (
        "Hi {name}, thanks for reaching out about your delivery{order}. Most orders arrive within 2–4 working days. "
        "We've asked the courier for an update and will message you within 24 hours. If it was marked delivered but "
        "you don't have it, please check with neighbours or security - we'll open an investigation if it doesn't turn up."
    ),
    "returns": (
        "Hi {name}, you can return most items within 7 days of delivery from My Orders{order}. Once the pickup is done, "
        "refunds reach UPI/cards in 3–5 working days and cash-on-delivery refunds go to your bank account."
    ),
    "payment": (
        "Hi {name}, sorry for the payment trouble{order}. If money was debited without an order being placed, it is "
        "automatically reversed by your bank within 5–7 working days. If you were charged twice, we'll refund the extra "
        "amount - our payments team is checking the transaction now."
    ),
    "product": (
        "Hi {name}, we're sorry the product didn't meet expectations{order}. Please share a photo of the item and its "
        "packaging; we'll arrange a free replacement or a full refund, and warranty claims are handled with the brand."
    ),
    "account": (
        "Hi {name}, for account issues you can reset your password from the login page or sign in with Google. "
        "If you think someone else accessed your account, change your password right away - we've flagged it for review."
    ),
    "order_change": (
        "Hi {name}, orders can be cancelled from My Orders{order} until they ship. Address and item changes aren't possible "
        "after the order is placed, so the quickest option is to cancel and re-order - refunds are automatic."
    ),
}
