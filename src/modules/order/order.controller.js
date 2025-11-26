import { catchAsyncError } from "../../utils/catchAsyncError.js";
import { AppError } from "../../utils/AppError.js";
import { cartModel } from "../../../Database/models/cart.model.js";
import { productModel } from "../../../Database/models/product.model.js";
import { orderModel } from "../../../Database/models/order.model.js";

import Stripe from "stripe";
import { userModel } from "../../../Database/models/user.model.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const createCashOrder = catchAsyncError(async (req, res, next) => {
  let cart = await cartModel.findById(req.params.id);

  let totalOrderPrice = cart.totalPriceAfterDiscount
    ? cart.totalPriceAfterDiscount
    : cart.totalPrice;

  const order = new orderModel({
    userId: req.user._id,
    cartItem: cart.cartItem,
    totalOrderPrice,
    shippingAddress: req.body.shippingAddress,
  });

  await order.save();

  if (order) {
    let options = cart.cartItem.map((item) => ({
      updateOne: {
        filter: { _id: item.productId },
        update: { $inc: { quantity: -item.quantity, sold: item.quantity } },
      },
    }));

    await productModel.bulkWrite(options);

    await cartModel.findByIdAndDelete(req.params.id);

    return res.status(201).json({ message: "success", order });
  } else {
    next(new AppError("Error in cart ID", 404));
  }
});

const getSpecificOrder = catchAsyncError(async (req, res, next) => {
  let order = await orderModel
    .findOne({ userId: req.user._id })
    .populate("cartItems.productId");

  res.status(200).json({ message: "success", order });
});

const getAllOrders = catchAsyncError(async (req, res, next) => {
  let orders = await orderModel.find({}).populate("cartItems.productId");

  res.status(200).json({ message: "success", orders });
});

const createCheckOutSession = catchAsyncError(async (req, res, next) => {
  let cart = await cartModel.findById(req.params.id);
  if (!cart) return next(new AppError("Cart was not found", 404));

  let totalOrderPrice = cart.totalPriceAfterDiscount
    ? cart.totalPriceAfterDiscount
    : cart.totalPrice;

  let sessions = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "egp",
          unit_amount: totalOrderPrice * 100,
          product_data: {
            name: req.user.name,
          },
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: process.env.SUCCESS_URL,
    cancel_url: process.env.CANCEL_URL,
    customer_email: req.user.email,
    client_reference_id: req.params.id,
    metadata: req.body.shippingAddress,
  });

  res.json({ message: "success", sessions });
});

const createOnlineOrder = catchAsyncError(async (req, res, next) => {
  const sig = req.headers["stripe-signature"].toString();

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    await handleCompletedSession(event.data.object, res);
  } else {
    console.log(`Unhandled event type ${event.type}`);
  }
});

async function handleCompletedSession(session, res) {
  let cart = await cartModel.findById(session.client_reference_id);
  if (!cart) return res.status(404).json({ message: "Cart not found" });

  let user = await userModel.findOne({ email: session.customer_email });

  const order = new orderModel({
    userId: user._id,
    cartItem: cart.cartItem,
    totalOrderPrice: session.amount_total / 100,
    shippingAddress: session.metadata.shippingAddress,
    paymentMethod: "card",
    isPaid: true,
    paidAt: Date.now(),
  });

  await order.save();

  let options = cart.cartItem.map((item) => ({
    updateOne: {
      filter: { _id: item.productId },
      update: { $inc: { quantity: -item.quantity, sold: item.quantity } },
    },
  }));

  await productModel.bulkWrite(options);

  await cartModel.findOneAndDelete({ userId: user._id });

  return res.status(201).json({ message: "success", order });
}

export {
  createCashOrder,
  getSpecificOrder,
  getAllOrders,
  createCheckOutSession,
  createOnlineOrder,
};
