import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ------------------------------------------------------------------ *
 *  DATA
 * ------------------------------------------------------------------ */

const AISLE_ORDER = [
  "Produce",
  "Meat & Seafood",
  "Dairy & Eggs",
  "Bakery",
  "Grains & Pasta",
  "Canned & Jarred",
  "Pantry",
  "Spices",
  "Frozen", // last on purpose — nothing melts on the walk to the register
];

const P = "Produce",
  M = "Meat & Seafood",
  D = "Dairy & Eggs",
  B = "Bakery",
  G = "Grains & Pasta",
  C = "Canned & Jarred",
  N = "Pantry",
  S = "Spices",
  F = "Frozen";

const RECIPES = [
  {
    id: "sheetpan-chili-chicken",
    name: "Sheet-Pan Chili Chicken & Sweet Potato",
    cat: "Chicken",
    source: "Pinch of Yum",
    time: 45,
    servings: 4,
    keeps: "4 days",
    tags: ["Sheet pan", "Gluten-free", "One cleanup"],
    blurb:
      "Three pans, forty-five minutes, five lunches. The avocado stays whole until the morning you eat it.",
    ing: [
      { item: "chicken breast", qty: 1.5, unit: "lb", aisle: M },
      { item: "sweet potatoes", qty: 2, unit: "lb", aisle: P },
      { item: "broccoli", qty: 1, unit: "lb", aisle: P },
      { item: "avocados", qty: 2, unit: "", aisle: P },
      { item: "limes", qty: 2, unit: "", aisle: P },
      { item: "olive oil", qty: 3, unit: "tbsp", aisle: N },
      { item: "chili powder", qty: 2, unit: "tsp", aisle: S },
      { item: "ground cumin", qty: 2, unit: "tsp", aisle: S },
      { item: "smoked paprika", qty: 1, unit: "tsp", aisle: S },
      { item: "garlic powder", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Heat the oven to 400°F. Mix the chili powder, cumin, paprika, garlic powder and salt in a small bowl.",
      "Cube the sweet potatoes, toss with half the oil and half the spice mix, spread on a sheet pan and roast 15 minutes.",
      "Cube the chicken and toss with the rest of the oil and spice. Add it to a second pan with the broccoli florets.",
      "Roast both pans 20 more minutes, until the chicken reads 165°F and the sweet potato edges catch.",
      "Cool completely on the counter before lidding — steam is what turns prepped food soggy.",
      "Divide into four containers. Keep the avocados and limes whole on the counter and cut one fresh each day.",
    ],
  },
  {
    id: "chicken-shawarma-bowls",
    name: "Chicken Shawarma Bowls",
    cat: "Chicken",
    source: "Budget Bytes",
    time: 40,
    servings: 5,
    keeps: "4 days",
    tags: ["Marinate ahead", "High protein"],
    blurb:
      "A yogurt-and-warm-spice marinade does the work overnight. Tastes better on day three than day one.",
    ing: [
      { item: "boneless skinless chicken thighs", qty: 2, unit: "lb", aisle: M },
      { item: "plain Greek yogurt", qty: 1, unit: "cup", aisle: D },
      { item: "lemons", qty: 2, unit: "", aisle: P },
      { item: "garlic cloves", qty: 6, unit: "", aisle: P },
      { item: "cucumbers", qty: 2, unit: "", aisle: P },
      { item: "cherry tomatoes", qty: 1, unit: "pint", aisle: P },
      { item: "red onion", qty: 1, unit: "", aisle: P },
      { item: "long-grain rice", qty: 2, unit: "cup", aisle: G },
      { item: "olive oil", qty: 3, unit: "tbsp", aisle: N },
      { item: "ground cumin", qty: 2, unit: "tsp", aisle: S },
      { item: "ground coriander", qty: 1, unit: "tsp", aisle: S },
      { item: "turmeric", qty: 1, unit: "tsp", aisle: S },
      { item: "cinnamon", qty: 0.5, unit: "tsp", aisle: S },
      { item: "smoked paprika", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
    ],
    steps: [
      "Whisk the yogurt, juice of one lemon, grated garlic, olive oil and all the spices into a marinade.",
      "Add the thighs, turn to coat, and refrigerate at least 30 minutes — overnight is better.",
      "Spread on a sheet pan and roast at 425°F for 25–30 minutes, until the edges char.",
      "Rest 10 minutes, then slice against the grain. Cook the rice while it rests.",
      "Chop the cucumber, tomatoes and red onion into a rough salad.",
      "Layer rice, chicken and salad in containers. Squeeze the second lemon over each bowl right before eating.",
    ],
  },
  {
    id: "gochujang-chicken",
    name: "Slow-Cooker Gochujang Chicken",
    cat: "Chicken",
    source: "GypsyPlate",
    time: 240,
    servings: 6,
    keeps: "5 days",
    tags: ["Slow cooker", "Hands-off", "Freezes"],
    blurb:
      "Sticky, savory shredded chicken that goes into bowls, tacos or lettuce wraps without tasting like the same meal twice.",
    ing: [
      { item: "boneless skinless chicken thighs", qty: 3, unit: "lb", aisle: M },
      { item: "garlic cloves", qty: 6, unit: "", aisle: P },
      { item: "fresh ginger", qty: 2, unit: "inch", aisle: P },
      { item: "scallions", qty: 1, unit: "bunch", aisle: P },
      { item: "cucumbers", qty: 2, unit: "", aisle: P },
      { item: "long-grain rice", qty: 2, unit: "cup", aisle: G },
      { item: "gochujang", qty: 0.33, unit: "cup", aisle: N },
      { item: "soy sauce", qty: 0.25, unit: "cup", aisle: N },
      { item: "honey", qty: 3, unit: "tbsp", aisle: N },
      { item: "rice vinegar", qty: 2, unit: "tbsp", aisle: N },
      { item: "toasted sesame oil", qty: 1, unit: "tbsp", aisle: N },
      { item: "sesame seeds", qty: 1, unit: "tbsp", aisle: S },
    ],
    steps: [
      "Whisk the gochujang, soy sauce, honey, rice vinegar, sesame oil, grated garlic and ginger together.",
      "Put the thighs in the slow cooker, pour the sauce over, and cook on low for 4 hours.",
      "Shred the chicken directly in the pot so it drinks the sauce back up.",
      "If the sauce is thin, ladle a cup into a skillet and reduce it for 5 minutes, then stir it back in.",
      "Cook the rice. Portion chicken over rice with sliced cucumber alongside.",
      "Add scallions and sesame seeds at serving, not now — they stay sharp that way.",
    ],
  },
  {
    id: "buffalo-chicken-bowls",
    name: "Buffalo Chicken Rice Bowls",
    cat: "Chicken",
    source: "Pinch of Yum",
    time: 40,
    servings: 5,
    keeps: "4 days",
    tags: ["High protein", "Reader favorite"],
    blurb:
      "Shredded buffalo chicken, a half-cauliflower rice base, and a cold dill sauce that makes the whole thing work.",
    ing: [
      { item: "chicken breast", qty: 2, unit: "lb", aisle: M },
      { item: "cherry tomatoes", qty: 1, unit: "pint", aisle: P },
      { item: "cucumbers", qty: 2, unit: "", aisle: P },
      { item: "fresh dill", qty: 0.25, unit: "cup", aisle: P },
      { item: "lemons", qty: 1, unit: "", aisle: P },
      { item: "plain Greek yogurt", qty: 1, unit: "cup", aisle: D },
      { item: "butter", qty: 2, unit: "tbsp", aisle: D },
      { item: "white rice", qty: 1.5, unit: "cup", aisle: G },
      { item: "frozen cauliflower rice", qty: 12, unit: "oz", aisle: F },
      { item: "buffalo hot sauce", qty: 0.75, unit: "cup", aisle: N },
      { item: "mayonnaise", qty: 0.25, unit: "cup", aisle: N },
      { item: "garlic powder", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1, unit: "tsp", aisle: S },
    ],
    steps: [
      "Bake the chicken at 400°F for about 22 minutes, then shred it with two forks while warm.",
      "Melt the butter into the buffalo sauce and toss the shredded chicken through it.",
      "Cook the rice, then stir the cauliflower rice in during the last two minutes so it steams through.",
      "Blend the yogurt, mayo, dill, lemon juice, garlic powder and salt into a pourable dill sauce.",
      "Portion rice, chicken, halved tomatoes and sliced cucumber.",
      "Pack the dill sauce in separate small containers — poured now, it thins out by Wednesday.",
    ],
  },
  {
    id: "honey-mustard-sheetpan",
    name: "Sheet-Pan Honey Mustard Chicken & Veg",
    cat: "Chicken",
    source: "Budget Bytes",
    time: 55,
    servings: 4,
    keeps: "4 days",
    tags: ["Sheet pan", "One cleanup"],
    blurb:
      "Bone-in thighs render fat down onto the potatoes underneath. That's the entire trick.",
    ing: [
      { item: "bone-in chicken thighs", qty: 3, unit: "lb", aisle: M },
      { item: "baby potatoes", qty: 1.5, unit: "lb", aisle: P },
      { item: "Brussels sprouts", qty: 1, unit: "lb", aisle: P },
      { item: "carrots", qty: 1, unit: "lb", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "Dijon mustard", qty: 0.25, unit: "cup", aisle: N },
      { item: "honey", qty: 3, unit: "tbsp", aisle: N },
      { item: "olive oil", qty: 2, unit: "tbsp", aisle: N },
      { item: "dried thyme", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
      { item: "black pepper", qty: 1, unit: "tsp", aisle: S },
    ],
    steps: [
      "Whisk the Dijon, honey and grated garlic into a glaze.",
      "Halve the potatoes and sprouts, chunk the carrots, and toss everything with oil, salt, pepper and thyme.",
      "Spread the vegetables on a sheet pan and nestle the thighs skin-side up among them. Brush with glaze.",
      "Roast at 425°F for 40–45 minutes, brushing with more glaze at the 25-minute mark.",
      "Cool, then portion. The skin softens in the fridge — crisp it back under the broiler for 2 minutes if you care.",
    ],
  },
  {
    id: "chipotle-chicken-chili",
    name: "Chipotle Chicken & Bean Chili",
    cat: "Chicken",
    source: "Budget Bytes · 4.8★ (24 reviews)",
    time: 60,
    servings: 8,
    keeps: "5 days · 3 months frozen",
    tags: ["Freezes", "Big batch", "Cheap"],
    blurb:
      "One of the highest-rated things on Budget Bytes, at roughly a dollar a serving. Makes eight portions and freezes flat.",
    ing: [
      { item: "boneless skinless chicken thighs", qty: 2, unit: "lb", aisle: M },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "pinto beans", qty: 2, unit: "can", aisle: C },
      { item: "black beans", qty: 1, unit: "can", aisle: C },
      { item: "diced tomatoes", qty: 28, unit: "oz", aisle: C },
      { item: "chipotle peppers in adobo", qty: 1, unit: "can", aisle: C },
      { item: "chicken broth", qty: 2, unit: "cup", aisle: C },
      { item: "olive oil", qty: 1, unit: "tbsp", aisle: N },
      { item: "chili powder", qty: 2, unit: "tbsp", aisle: S },
      { item: "ground cumin", qty: 2, unit: "tsp", aisle: S },
      { item: "dried oregano", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
    ],
    steps: [
      "Sweat the diced onion and garlic in oil until soft, about 6 minutes.",
      "Add the chili powder, cumin and oregano and stir for 30 seconds to wake them up.",
      "Add the tomatoes, broth, two minced chipotles with a spoon of their adobo, and the whole thighs. Simmer 30 minutes.",
      "Pull the chicken out, shred it, and return it to the pot.",
      "Add the drained beans and simmer 10 more minutes. Salt to taste.",
      "Cool, then portion into bags laid flat in the freezer so they stack and thaw fast.",
    ],
  },
  {
    id: "burrito-bowls",
    name: "Easiest Burrito Bowls",
    cat: "Beef & Turkey",
    source: "Budget Bytes",
    time: 30,
    servings: 4,
    keeps: "5 days",
    tags: ["30 minutes", "Cheap", "Gluten-free"],
    blurb:
      "The one people in the comments say they've made a dozen times. Holds five days without going strange.",
    ing: [
      { item: "ground turkey", qty: 1, unit: "lb", aisle: M },
      { item: "limes", qty: 2, unit: "", aisle: P },
      { item: "cilantro", qty: 1, unit: "bunch", aisle: P },
      { item: "shredded cheddar", qty: 4, unit: "oz", aisle: D },
      { item: "long-grain rice", qty: 1.5, unit: "cup", aisle: G },
      { item: "black beans", qty: 2, unit: "can", aisle: C },
      { item: "salsa", qty: 1.5, unit: "cup", aisle: C },
      { item: "frozen corn", qty: 2, unit: "cup", aisle: F },
      { item: "chili powder", qty: 1, unit: "tbsp", aisle: S },
      { item: "ground cumin", qty: 1, unit: "tsp", aisle: S },
      { item: "garlic powder", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1, unit: "tsp", aisle: S },
    ],
    steps: [
      "Brown the turkey with the chili powder, cumin, garlic powder and salt.",
      "Stir in the drained beans and salsa and simmer 10 minutes until it thickens.",
      "Cook the rice, then fold in lime juice and the thawed corn.",
      "Divide the rice between four containers, then the turkey mixture on top.",
      "Finish with cheese and chopped cilantro. Eat cold or microwave 2 minutes.",
    ],
  },
  {
    id: "chipotle-turkey-burritos",
    name: "Freezer Chipotle Turkey Burritos",
    cat: "Beef & Turkey",
    source: "Pinch of Yum",
    time: 50,
    servings: 8,
    keeps: "3 months frozen",
    tags: ["Freezes", "Grab and go", "Big batch"],
    blurb:
      "Eight burritos, wrapped in foil, straight from freezer to oven. The one non-negotiable step is cooling the filling first.",
    ing: [
      { item: "ground turkey", qty: 1.5, unit: "lb", aisle: M },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 3, unit: "", aisle: P },
      { item: "shredded Monterey Jack", qty: 8, unit: "oz", aisle: D },
      { item: "large flour tortillas", qty: 8, unit: "", aisle: B },
      { item: "brown rice", qty: 1.5, unit: "cup", aisle: G },
      { item: "black beans", qty: 2, unit: "can", aisle: C },
      { item: "chipotle peppers in adobo", qty: 1, unit: "can", aisle: C },
      { item: "frozen corn", qty: 1.5, unit: "cup", aisle: F },
      { item: "ground cumin", qty: 2, unit: "tsp", aisle: S },
      { item: "chili powder", qty: 2, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Cook the brown rice and set it aside to steam dry.",
      "Sauté the onion and garlic, brown the turkey, then add the beans, corn, 2 tbsp minced chipotle and the spices. Simmer 8 minutes.",
      "Cool the rice and filling completely. Warm filling makes soggy burritos and ice crystals.",
      "Lay out a tortilla, add rice, filling and cheese in a line, fold the sides in and roll tight.",
      "Wrap each in foil and freeze. Reheat from frozen at 375°F for 35 minutes in the foil, or unwrap and microwave 3 minutes.",
    ],
  },
  {
    id: "turkey-meatballs",
    name: "Baked Turkey Meatballs",
    cat: "Beef & Turkey",
    source: "GypsyPlate",
    time: 35,
    servings: 6,
    keeps: "4 days · 3 months frozen",
    tags: ["Freezes", "Component prep"],
    blurb:
      "Not a meal so much as a building block — pasta Monday, subs Wednesday, dropped into soup Friday.",
    ing: [
      { item: "ground turkey", qty: 2, unit: "lb", aisle: M },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "flat-leaf parsley", qty: 0.5, unit: "cup", aisle: P },
      { item: "eggs", qty: 2, unit: "", aisle: D },
      { item: "grated parmesan", qty: 0.75, unit: "cup", aisle: D },
      { item: "breadcrumbs", qty: 1, unit: "cup", aisle: N },
      { item: "olive oil", qty: 1, unit: "tbsp", aisle: N },
      { item: "dried oregano", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
      { item: "black pepper", qty: 1, unit: "tsp", aisle: S },
    ],
    steps: [
      "Grate the onion and garlic on a box grater — it distributes better than dicing and keeps the meatballs moist.",
      "Mix everything with your hands until just combined. Overworking makes them bouncy.",
      "Roll into 1½-inch balls on a lined sheet pan.",
      "Bake at 400°F for 18–20 minutes, to an internal 165°F.",
      "Cool. Fridge for 4 days, or freeze on the tray first and then bag them so they don't fuse.",
    ],
  },
  {
    id: "bulk-taco-meat",
    name: "Bulk Taco Meat",
    cat: "Beef & Turkey",
    source: "GypsyPlate",
    time: 25,
    servings: 8,
    keeps: "4 days · 3 months frozen",
    tags: ["Freezes", "Component prep", "Cheap"],
    blurb:
      "Season two pounds at once and freeze it flat. Becomes tacos, nachos, quesadillas or a rice bowl with zero further thought.",
    ing: [
      { item: "ground beef", qty: 2, unit: "lb", aisle: M },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "tomato paste", qty: 2, unit: "tbsp", aisle: C },
      { item: "beef broth", qty: 1, unit: "cup", aisle: C },
      { item: "chili powder", qty: 2, unit: "tbsp", aisle: S },
      { item: "ground cumin", qty: 1, unit: "tbsp", aisle: S },
      { item: "smoked paprika", qty: 2, unit: "tsp", aisle: S },
      { item: "dried oregano", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
    ],
    steps: [
      "Brown the beef hard in a dry pan, then drain off most of the fat.",
      "Add the diced onion and garlic and cook 4 minutes.",
      "Stir in the tomato paste and all the spices and cook 1 minute until it smells toasted.",
      "Pour in the broth and simmer 10 minutes until glossy rather than watery.",
      "Cool, portion into two-cup bags, and freeze flat.",
    ],
  },
  {
    id: "coconut-curry-lentils",
    name: "Slow-Cooker Coconut Curry Lentils",
    cat: "Vegetarian",
    source: "Budget Bytes",
    time: 480,
    servings: 8,
    keeps: "5 days · 3 months frozen",
    tags: ["Slow cooker", "Vegan", "Freezes", "Cheap"],
    blurb:
      "Basically cooks itself. Makes a big enough batch that half goes in the freezer for a week you haven't planned yet.",
    ing: [
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "fresh ginger", qty: 2, unit: "inch", aisle: P },
      { item: "baby spinach", qty: 5, unit: "oz", aisle: P },
      { item: "long-grain rice", qty: 2, unit: "cup", aisle: G },
      { item: "brown lentils", qty: 1, unit: "lb", aisle: N },
      { item: "coconut milk", qty: 14, unit: "oz", aisle: C },
      { item: "diced tomatoes", qty: 14, unit: "oz", aisle: C },
      { item: "vegetable broth", qty: 3, unit: "cup", aisle: C },
      { item: "curry powder", qty: 2, unit: "tbsp", aisle: S },
      { item: "turmeric", qty: 1, unit: "tsp", aisle: S },
      { item: "ground cumin", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
    ],
    steps: [
      "Put everything except the coconut milk and spinach into the slow cooker. No browning, no sautéing.",
      "Cook on low for 8 hours or high for 4.",
      "Stir in the coconut milk and the spinach at the very end and let the residual heat wilt it.",
      "Salt aggressively — lentils absorb more than you expect.",
      "Serve over rice. Freezes better than almost anything else on this list.",
    ],
  },
  {
    id: "spanish-chickpeas-rice",
    name: "Spanish Chickpeas & Rice",
    cat: "Vegetarian",
    source: "Budget Bytes",
    time: 35,
    servings: 6,
    keeps: "5 days",
    tags: ["One pot", "Vegan", "Cheap", "Pantry staples"],
    blurb:
      "Budget Bytes calls this their most popular one-pot recipe. Smoked paprika does almost all of the lifting.",
    ing: [
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "red bell pepper", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "flat-leaf parsley", qty: 0.25, unit: "cup", aisle: P },
      { item: "lemons", qty: 1, unit: "", aisle: P },
      { item: "long-grain rice", qty: 1.5, unit: "cup", aisle: G },
      { item: "chickpeas", qty: 2, unit: "can", aisle: C },
      { item: "diced tomatoes", qty: 14, unit: "oz", aisle: C },
      { item: "vegetable broth", qty: 2.5, unit: "cup", aisle: C },
      { item: "olive oil", qty: 2, unit: "tbsp", aisle: N },
      { item: "smoked paprika", qty: 1, unit: "tbsp", aisle: S },
      { item: "ground cumin", qty: 1, unit: "tsp", aisle: S },
      { item: "dried oregano", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Sauté the diced onion, pepper and garlic in olive oil until soft.",
      "Add the paprika, cumin and oregano and stir for 30 seconds.",
      "Add the rice, tomatoes, drained chickpeas and broth. Bring to a boil.",
      "Cover, drop to low, and cook 20 minutes without lifting the lid.",
      "Rest 5 minutes off the heat, then fluff. Finish with parsley and a squeeze of lemon.",
    ],
  },
  {
    id: "roasted-veg-farro-bowls",
    name: "Roasted Veg & Feta Farro Bowls",
    cat: "Vegetarian",
    source: "Downshiftology",
    time: 45,
    servings: 5,
    keeps: "4 days",
    tags: ["Vegetarian", "Better on day two"],
    blurb:
      "Dress the farro while it's still warm so it drinks the lemon. Arugula goes in at the last second.",
    ing: [
      { item: "zucchini", qty: 2, unit: "", aisle: P },
      { item: "red bell pepper", qty: 2, unit: "", aisle: P },
      { item: "red onion", qty: 1, unit: "", aisle: P },
      { item: "cherry tomatoes", qty: 1, unit: "pint", aisle: P },
      { item: "garlic cloves", qty: 3, unit: "", aisle: P },
      { item: "lemons", qty: 2, unit: "", aisle: P },
      { item: "baby arugula", qty: 5, unit: "oz", aisle: P },
      { item: "feta", qty: 6, unit: "oz", aisle: D },
      { item: "farro", qty: 2, unit: "cup", aisle: G },
      { item: "chickpeas", qty: 1, unit: "can", aisle: C },
      { item: "olive oil", qty: 0.25, unit: "cup", aisle: N },
      { item: "dried oregano", qty: 2, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Cook the farro in salted water until chewy, about 25 minutes, then drain.",
      "Chop the zucchini, peppers and onion. Toss with half the oil, oregano and salt along with the drained chickpeas.",
      "Roast at 425°F for 25 minutes, adding the tomatoes for the last 10.",
      "Whisk the remaining oil with lemon juice and grated garlic.",
      "Combine the warm farro, vegetables and dressing. Cool, then portion with crumbled feta.",
      "Keep the arugula in its own bag and add a handful when you eat.",
    ],
  },
  {
    id: "sweet-potato-enchilada-skillet",
    name: "Black Bean & Sweet Potato Enchilada Skillet",
    cat: "Vegetarian",
    source: "Pinch of Yum",
    time: 40,
    servings: 5,
    keeps: "5 days",
    tags: ["One pot", "Vegetarian", "Cheap"],
    blurb:
      "Dice the sweet potato small — half-inch or less — or it stays crunchy in the middle while everything else is done.",
    ing: [
      { item: "sweet potatoes", qty: 2, unit: "lb", aisle: P },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 3, unit: "", aisle: P },
      { item: "cilantro", qty: 1, unit: "bunch", aisle: P },
      { item: "limes", qty: 2, unit: "", aisle: P },
      { item: "shredded cheddar", qty: 6, unit: "oz", aisle: D },
      { item: "long-grain rice", qty: 1.5, unit: "cup", aisle: G },
      { item: "black beans", qty: 2, unit: "can", aisle: C },
      { item: "red enchilada sauce", qty: 15, unit: "oz", aisle: C },
      { item: "frozen corn", qty: 1.5, unit: "cup", aisle: F },
      { item: "olive oil", qty: 2, unit: "tbsp", aisle: N },
      { item: "chili powder", qty: 1, unit: "tbsp", aisle: S },
      { item: "ground cumin", qty: 2, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Dice the sweet potatoes small. Sauté the onion and garlic in oil, then add the potato and spices and cook 5 minutes.",
      "Pour in the enchilada sauce plus a half cup of water. Cover and simmer 15 minutes until the potato gives.",
      "Stir in the drained beans and the corn and cook 5 more minutes.",
      "Kill the heat, scatter the cheese over, and lid it until melted.",
      "Cook the rice separately and portion underneath. Lime and cilantro go on at serving.",
    ],
  },
  {
    id: "lasagna-soup",
    name: "One-Pot Lasagna Soup",
    cat: "Soup",
    source: "Rachael's Good Eats",
    time: 45,
    servings: 6,
    keeps: "4 days",
    tags: ["One pot", "Comfort", "High protein"],
    blurb:
      "All of lasagna, none of the layering. Cook the noodles separately if you're eating this past Wednesday.",
    ing: [
      { item: "ground beef", qty: 1, unit: "lb", aisle: M },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 5, unit: "", aisle: P },
      { item: "fresh basil", qty: 0.5, unit: "cup", aisle: P },
      { item: "ricotta", qty: 15, unit: "oz", aisle: D },
      { item: "shredded mozzarella", qty: 6, unit: "oz", aisle: D },
      { item: "lasagna noodles", qty: 8, unit: "oz", aisle: G },
      { item: "crushed tomatoes", qty: 28, unit: "oz", aisle: C },
      { item: "tomato paste", qty: 2, unit: "tbsp", aisle: C },
      { item: "beef broth", qty: 6, unit: "cup", aisle: C },
      { item: "olive oil", qty: 1, unit: "tbsp", aisle: N },
      { item: "Italian seasoning", qty: 1, unit: "tbsp", aisle: S },
      { item: "red pepper flakes", qty: 0.5, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
    ],
    steps: [
      "Brown the beef with the onion and garlic in a large pot.",
      "Stir in the tomato paste and cook 1 minute.",
      "Add the crushed tomatoes, broth, Italian seasoning and pepper flakes. Simmer 15 minutes.",
      "Break the lasagna noodles into rough pieces and cook them in the pot for 10 minutes — or boil them separately if you're storing this more than two days, since they keep swelling in the broth.",
      "Cool and portion the soup. Dollop ricotta, mozzarella and torn basil on when you reheat.",
    ],
  },
  {
    id: "split-pea-soup",
    name: "Split Pea Soup",
    cat: "Soup",
    source: "GypsyPlate",
    time: 90,
    servings: 8,
    keeps: "5 days · 3 months frozen",
    tags: ["Freezes", "Cheap", "Big batch"],
    blurb:
      "Under two dollars a bowl and it improves overnight. It also thickens to concrete — thin it with water on reheat.",
    ing: [
      { item: "carrots", qty: 4, unit: "", aisle: P },
      { item: "celery", qty: 4, unit: "stalk", aisle: P },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 4, unit: "", aisle: P },
      { item: "smoked ham hock", qty: 1, unit: "", aisle: M },
      { item: "dried split peas", qty: 1, unit: "lb", aisle: N },
      { item: "olive oil", qty: 2, unit: "tbsp", aisle: N },
      { item: "vegetable broth", qty: 8, unit: "cup", aisle: C },
      { item: "bay leaves", qty: 2, unit: "", aisle: S },
      { item: "dried thyme", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1.5, unit: "tsp", aisle: S },
      { item: "black pepper", qty: 1, unit: "tsp", aisle: S },
    ],
    steps: [
      "Sweat the diced onion, carrot and celery in oil for 8 minutes, then add the garlic for one more.",
      "Add the rinsed split peas, broth, ham hock, bay leaves and thyme.",
      "Simmer 60–75 minutes, until the peas collapse into the broth.",
      "Fish out the hock, shred the meat off it, and stir the meat back in. Discard the bay leaves.",
      "Blend part of it with an immersion blender if you like it smooth. Season, cool, portion.",
    ],
  },
  {
    id: "tuscan-white-bean-kale",
    name: "Tuscan White Bean & Kale Soup",
    cat: "Soup",
    source: "Budget Bytes",
    time: 40,
    servings: 6,
    keeps: "5 days · 3 months frozen",
    tags: ["Freezes", "Vegan option", "Pantry staples"],
    blurb:
      "Mashing one can of the beans is what gives it body without cream. Almost entirely pantry shelf.",
    ing: [
      { item: "kale", qty: 1, unit: "bunch", aisle: P },
      { item: "carrots", qty: 3, unit: "", aisle: P },
      { item: "celery", qty: 3, unit: "stalk", aisle: P },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "garlic cloves", qty: 5, unit: "", aisle: P },
      { item: "lemons", qty: 1, unit: "", aisle: P },
      { item: "cannellini beans", qty: 3, unit: "can", aisle: C },
      { item: "diced tomatoes", qty: 14, unit: "oz", aisle: C },
      { item: "vegetable broth", qty: 6, unit: "cup", aisle: C },
      { item: "olive oil", qty: 3, unit: "tbsp", aisle: N },
      { item: "dried rosemary", qty: 1, unit: "tbsp", aisle: S },
      { item: "red pepper flakes", qty: 0.5, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 2, unit: "tsp", aisle: S },
    ],
    steps: [
      "Sauté the diced onion, carrot and celery in oil for 8 minutes.",
      "Add the garlic, rosemary and pepper flakes and cook 1 minute.",
      "Add the tomatoes, broth and two drained cans of beans.",
      "Mash the third can with a fork and stir it in — that's the body.",
      "Simmer 25 minutes, then add the stripped, chopped kale for the last 5.",
      "Finish with lemon juice off the heat. It brightens the whole pot.",
    ],
  },
  {
    id: "breakfast-sandwiches",
    name: "Sheet-Pan Breakfast Sandwiches",
    cat: "Breakfast",
    source: "Pinch of Yum",
    time: 45,
    servings: 8,
    keeps: "2 months frozen",
    tags: ["Freezes", "Grab and go"],
    blurb:
      "Bake the eggs flat on a pan and cut them into squares. Eight sandwiches wrapped and stacked in the freezer.",
    ing: [
      { item: "baby spinach", qty: 5, unit: "oz", aisle: P },
      { item: "eggs", qty: 12, unit: "", aisle: D },
      { item: "whole milk", qty: 0.5, unit: "cup", aisle: D },
      { item: "cheddar slices", qty: 8, unit: "", aisle: D },
      { item: "butter", qty: 1, unit: "tbsp", aisle: D },
      { item: "bacon", qty: 12, unit: "slice", aisle: M },
      { item: "English muffins", qty: 8, unit: "", aisle: B },
      { item: "kosher salt", qty: 1, unit: "tsp", aisle: S },
      { item: "black pepper", qty: 0.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Heat the oven to 375°F. Lay the bacon on a lined sheet pan and bake 18 minutes.",
      "Whisk the eggs with milk, salt and pepper, then stir in the chopped spinach.",
      "Pour into a buttered quarter sheet pan and bake 15 minutes, until just set — pull it before it browns.",
      "Cut the egg sheet into 8 squares. Toast the muffins lightly so they don't go to mush.",
      "Stack muffin, egg, bacon and cheese. Wrap each in parchment, then foil.",
      "From frozen: 90 seconds in the microwave wrapped in a paper towel, or 20 minutes at 350°F in the foil.",
    ],
  },
  {
    id: "overnight-oats",
    name: "Overnight Oats, Four Ways",
    cat: "Breakfast",
    source: "Downshiftology",
    time: 10,
    servings: 6,
    keeps: "5 days",
    tags: ["No cook", "10 minutes", "Grab and go"],
    blurb:
      "The most-repeated breakfast prep on the internet for a reason. Ten minutes of stirring buys you a week.",
    ing: [
      { item: "mixed berries", qty: 2, unit: "cup", aisle: P },
      { item: "bananas", qty: 2, unit: "", aisle: P },
      { item: "milk", qty: 3, unit: "cup", aisle: D },
      { item: "plain Greek yogurt", qty: 1, unit: "cup", aisle: D },
      { item: "rolled oats", qty: 3, unit: "cup", aisle: N },
      { item: "chia seeds", qty: 0.25, unit: "cup", aisle: N },
      { item: "maple syrup", qty: 3, unit: "tbsp", aisle: N },
      { item: "peanut butter", qty: 0.25, unit: "cup", aisle: N },
      { item: "vanilla extract", qty: 2, unit: "tsp", aisle: N },
      { item: "cinnamon", qty: 1, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 0.25, unit: "tsp", aisle: S },
    ],
    steps: [
      "Per jar: ½ cup oats, ½ cup milk, 2 tbsp yogurt, 2 tsp chia, a splash of vanilla, a pinch of salt, a drizzle of maple.",
      "Stir each jar with a spoon rather than shaking it — shaking clumps the chia against the lid.",
      "Refrigerate overnight. They hold 5 days and thicken as the week goes on; loosen with a splash of milk.",
      "Toppings go on the morning you eat: berries in some, peanut butter and sliced banana in others, cinnamon over the rest.",
    ],
  },
  {
    id: "egg-muffin-cups",
    name: "Sausage & Pepper Egg Cups",
    cat: "Breakfast",
    source: "Classpop",
    time: 35,
    servings: 6,
    keeps: "4 days · 2 months frozen",
    tags: ["Freezes", "High protein", "Gluten-free"],
    blurb:
      "Twelve cups from a muffin tin. Grease the tin far more than feels reasonable or you'll be scraping.",
    ing: [
      { item: "red bell pepper", qty: 1, unit: "", aisle: P },
      { item: "yellow onion", qty: 1, unit: "", aisle: P },
      { item: "baby spinach", qty: 3, unit: "oz", aisle: P },
      { item: "eggs", qty: 12, unit: "", aisle: D },
      { item: "milk", qty: 0.25, unit: "cup", aisle: D },
      { item: "shredded cheddar", qty: 4, unit: "oz", aisle: D },
      { item: "breakfast sausage", qty: 8, unit: "oz", aisle: M },
      { item: "kosher salt", qty: 1, unit: "tsp", aisle: S },
      { item: "black pepper", qty: 0.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Heat the oven to 350°F and grease a 12-cup muffin tin thoroughly, sides included.",
      "Cook the sausage with the diced pepper and onion, then drain the fat off.",
      "Whisk the eggs with the milk, salt and pepper.",
      "Divide the sausage mixture, chopped spinach and cheese between the cups, then pour egg in to three-quarters full.",
      "Bake 20–22 minutes until puffed and set. Cool in the tin 5 minutes, then run a knife around each one.",
    ],
  },
  {
    id: "chia-pudding",
    name: "Mango Chia Pudding Jars",
    cat: "Breakfast",
    source: "Classpop",
    time: 10,
    servings: 6,
    keeps: "5 days",
    tags: ["No cook", "Vegan", "High fiber"],
    blurb:
      "Whisk it twice, ten minutes apart. That second whisk is the step everyone skips and then wonders about the lumps.",
    ing: [
      { item: "mangoes", qty: 2, unit: "", aisle: P },
      { item: "limes", qty: 1, unit: "", aisle: P },
      { item: "chia seeds", qty: 0.75, unit: "cup", aisle: N },
      { item: "coconut milk", qty: 3, unit: "cup", aisle: C },
      { item: "maple syrup", qty: 0.25, unit: "cup", aisle: N },
      { item: "vanilla extract", qty: 2, unit: "tsp", aisle: N },
      { item: "granola", qty: 1, unit: "cup", aisle: N },
      { item: "kosher salt", qty: 0.25, unit: "tsp", aisle: S },
    ],
    steps: [
      "Whisk the chia, coconut milk, maple syrup, vanilla and salt together in a bowl.",
      "Wait 10 minutes and whisk again hard to break up the clumps that have formed.",
      "Divide into jars and refrigerate at least 4 hours, ideally overnight.",
      "Keeps 5 days. Add diced mango, granola and a little lime zest when you eat it.",
    ],
  },
  {
    id: "chickpea-salad-jars",
    name: "Mediterranean Chickpea Salad Jars",
    cat: "No-reheat",
    source: "Classpop",
    time: 20,
    servings: 5,
    keeps: "5 days",
    tags: ["No cook", "No microwave", "Vegetarian"],
    blurb:
      "Built in layers so the dressing marinates the beans and never touches the cucumber. Shake into a bowl at your desk.",
    ing: [
      { item: "cucumbers", qty: 2, unit: "", aisle: P },
      { item: "cherry tomatoes", qty: 1, unit: "pint", aisle: P },
      { item: "red onion", qty: 1, unit: "", aisle: P },
      { item: "lemons", qty: 1, unit: "", aisle: P },
      { item: "feta", qty: 6, unit: "oz", aisle: D },
      { item: "chickpeas", qty: 2, unit: "can", aisle: C },
      { item: "roasted red peppers", qty: 12, unit: "oz", aisle: C },
      { item: "kalamata olives", qty: 1, unit: "cup", aisle: C },
      { item: "olive oil", qty: 0.33, unit: "cup", aisle: N },
      { item: "red wine vinegar", qty: 3, unit: "tbsp", aisle: N },
      { item: "dried oregano", qty: 2, unit: "tsp", aisle: S },
      { item: "kosher salt", qty: 1, unit: "tsp", aisle: S },
      { item: "black pepper", qty: 0.5, unit: "tsp", aisle: S },
    ],
    steps: [
      "Whisk the oil, vinegar, lemon juice, oregano, salt and pepper and pour it into the bottom of five jars.",
      "Layer in the drained chickpeas, olives, sliced roasted peppers and red onion — these want to sit in the dressing.",
      "Then cucumber and halved tomatoes, which don't.",
      "Crumbled feta on top, lid on, refrigerate.",
      "Shake hard and tip into a bowl when you're ready to eat.",
    ],
  },
  {
    id: "peanut-sesame-noodles",
    name: "Cold Peanut Sesame Noodle Bowls",
    cat: "No-reheat",
    source: "Budget Bytes",
    time: 30,
    servings: 5,
    keeps: "4 days",
    tags: ["No microwave", "Vegetarian", "Crunchy"],
    blurb:
      "Meant to be eaten cold, which means no sad office microwave line. Hold back a third of the sauce.",
    ing: [
      { item: "red cabbage", qty: 1, unit: "head", aisle: P },
      { item: "carrots", qty: 3, unit: "", aisle: P },
      { item: "cucumbers", qty: 2, unit: "", aisle: P },
      { item: "scallions", qty: 1, unit: "bunch", aisle: P },
      { item: "garlic cloves", qty: 3, unit: "", aisle: P },
      { item: "fresh ginger", qty: 1, unit: "inch", aisle: P },
      { item: "limes", qty: 2, unit: "", aisle: P },
      { item: "spaghetti", qty: 1, unit: "lb", aisle: G },
      { item: "frozen edamame", qty: 2, unit: "cup", aisle: F },
      { item: "peanut butter", qty: 0.5, unit: "cup", aisle: N },
      { item: "soy sauce", qty: 0.25, unit: "cup", aisle: N },
      { item: "rice vinegar", qty: 3, unit: "tbsp", aisle: N },
      { item: "toasted sesame oil", qty: 2, unit: "tbsp", aisle: N },
      { item: "honey", qty: 2, unit: "tbsp", aisle: N },
      { item: "sriracha", qty: 1, unit: "tbsp", aisle: N },
      { item: "roasted peanuts", qty: 0.5, unit: "cup", aisle: N },
    ],
    steps: [
      "Boil the noodles, rinse them under cold water, and toss with a teaspoon of sesame oil so they don't glue together.",
      "Whisk the peanut butter, soy sauce, vinegar, remaining sesame oil, honey, sriracha, grated garlic and ginger. Thin with warm water until it pours.",
      "Shred the cabbage and carrots, slice the cucumber, thaw the edamame.",
      "Toss the noodles and vegetables with about two-thirds of the sauce.",
      "Portion, and keep the reserved sauce separate — the noodles drink it up by day two and you'll want more.",
      "Peanuts, scallions and lime at the table.",
    ],
  },
  {
    id: "tuna-guacamole-bowls",
    name: "Spicy Tuna Guacamole Bowls",
    cat: "No-reheat",
    source: "Budget Bytes · 4.7★ (37 reviews)",
    time: 20,
    servings: 4,
    keeps: "3 days",
    tags: ["No cook", "No microwave", "Under 20 min"],
    blurb:
      "About two dollars a serving and nothing gets heated. Mash the avocado the morning you eat it, not now.",
    ing: [
      { item: "avocados", qty: 3, unit: "", aisle: P },
      { item: "limes", qty: 3, unit: "", aisle: P },
      { item: "cherry tomatoes", qty: 1, unit: "pint", aisle: P },
      { item: "red onion", qty: 1, unit: "", aisle: P },
      { item: "jalapeño", qty: 1, unit: "", aisle: P },
      { item: "cilantro", qty: 1, unit: "bunch", aisle: P },
      { item: "canned tuna", qty: 3, unit: "can", aisle: C },
      { item: "black beans", qty: 1, unit: "can", aisle: C },
      { item: "mayonnaise", qty: 3, unit: "tbsp", aisle: N },
      { item: "sriracha", qty: 2, unit: "tbsp", aisle: N },
      { item: "tortilla chips", qty: 6, unit: "oz", aisle: N },
      { item: "kosher salt", qty: 1, unit: "tsp", aisle: S },
    ],
    steps: [
      "Drain the tuna properly — press it against the lid — then mix with the mayo and sriracha.",
      "Dice the onion, jalapeño and tomatoes into a quick pico with chopped cilantro, salt and lime juice.",
      "Pack the tuna, drained beans and pico into containers. Chips in a separate bag.",
      "Leave the avocados whole on the counter. Mash one with lime and salt each morning and add it then — guacamole packed in advance goes brown and sad no matter what trick you read.",
    ],
  },
];

const CATEGORIES = [
  "All",
  "Chicken",
  "Beef & Turkey",
  "Vegetarian",
  "Soup",
  "Breakfast",
  "No-reheat",
];

/* ------------------------------------------------------------------ *
 *  HELPERS
 * ------------------------------------------------------------------ */

const FRACTIONS = [
  [0.125, "⅛"],
  [0.25, "¼"],
  [0.333, "⅓"],
  [0.5, "½"],
  [0.667, "⅔"],
  [0.75, "¾"],
];

function fmtQty(n) {
  if (n == null) return "";
  const whole = Math.floor(n + 1e-9);
  const rem = +(n - whole).toFixed(3);
  for (const [val, glyph] of FRACTIONS) {
    if (Math.abs(rem - val) < 0.02) return whole ? `${whole}${glyph}` : glyph;
  }
  if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
  return String(+n.toFixed(2));
}

function fmtLine(qty, unit) {
  const q = fmtQty(qty);
  if (!unit) return q;
  const plural = qty > 1 && ["can", "stalk", "slice", "bunch", "head", "pint"].includes(unit);
  return `${q} ${unit}${plural ? "s" : ""}`;
}

function fmtTime(min) {
  if (min >= 120) return `${Math.round(min / 60)} hr`;
  return `${min} min`;
}

const STORE_KEY_SAVED = "mealprep:v1:saved";
const STORE_KEY_CHECKED = "mealprep:v1:checked";

/* ------------------------------------------------------------------ *
 *  STYLES
 * ------------------------------------------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Karla:ital,wght@0,400;0,500;0,700;1,400&family=Space+Mono:wght@400;700&display=swap');

.mp {
  --beet: #58203C;
  --beet-soft: #7C3A5B;
  --blush: #F5EEF0;
  --paper: #FFFCFA;
  --leaf: #2F6B4F;
  --leaf-soft: #E2EDE6;
  --amber: #C98A16;
  --slate: #55444B;
  --line: #E2D2D8;

  --display: 'Bricolage Grotesque', 'Trebuchet MS', sans-serif;
  --body: 'Karla', system-ui, sans-serif;
  --mono: 'Space Mono', ui-monospace, monospace;

  background: var(--blush);
  color: var(--slate);
  font-family: var(--body);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
.mp *, .mp *::before, .mp *::after { box-sizing: border-box; }
.mp button { font: inherit; color: inherit; cursor: pointer; border: none; background: none; }
.mp :focus-visible { outline: 2.5px solid var(--leaf); outline-offset: 2px; border-radius: 3px; }

.mp-wrap { max-width: 760px; margin: 0 auto; padding: 0 18px 120px; }

/* ---- masthead ---- */
.mp-head { padding: 34px 0 20px; }
.mp-eyebrow {
  font-family: var(--mono); font-size: 11px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--beet-soft);
}
.mp-title {
  font-family: var(--display); font-weight: 800;
  font-size: clamp(38px, 11vw, 62px); line-height: .93;
  letter-spacing: -.035em; color: var(--beet); margin: 12px 0 0;
}
.mp-title em { font-style: normal; color: var(--leaf); }
.mp-sub { margin: 14px 0 0; max-width: 46ch; font-size: 15px; line-height: 1.55; }

/* ---- tabs ---- */
.mp-tabs {
  position: sticky; top: 0; z-index: 30;
  display: flex; gap: 4px; padding: 10px 0;
  background: linear-gradient(var(--blush) 72%, rgba(245,238,240,0));
}
.mp-tab {
  flex: 1; padding: 11px 6px; border-radius: 999px;
  font-family: var(--mono); font-size: 11.5px; letter-spacing: .09em;
  text-transform: uppercase; color: var(--beet-soft);
  border: 1.5px solid var(--line); background: var(--paper);
  transition: background .16s, color .16s, border-color .16s;
  white-space: nowrap;
}
.mp-tab[data-on="true"] { background: var(--beet); color: #FFF7FA; border-color: var(--beet); }
.mp-tab-n {
  display: inline-block; margin-left: 5px; padding: 1px 5px;
  border-radius: 6px; background: var(--amber); color: #2A1119; font-weight: 700;
}

/* ---- filter chips ---- */
.mp-chips { display: flex; gap: 7px; overflow-x: auto; padding: 4px 0 16px; scrollbar-width: none; }
.mp-chips::-webkit-scrollbar { display: none; }
.mp-chip {
  flex: 0 0 auto; padding: 7px 13px; border-radius: 999px;
  border: 1.5px solid var(--line); background: transparent;
  font-size: 13px; font-weight: 500; color: var(--slate);
}
.mp-chip[data-on="true"] { background: var(--leaf); border-color: var(--leaf); color: #F2F8F4; }

/* ---- recipe card ---- */
.mp-grid { display: grid; gap: 12px; }
.mp-card {
  position: relative; background: var(--paper);
  border: 1.5px solid var(--line); border-radius: 14px;
  padding: 16px 16px 14px; text-align: left; width: 100%;
  transition: border-color .16s, transform .16s;
}
.mp-card[data-on="true"] { border-color: var(--leaf); background: var(--leaf-soft); }
.mp-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.mp-card-name {
  font-family: var(--display); font-weight: 700; font-size: 19px;
  line-height: 1.14; letter-spacing: -.02em; color: var(--beet); margin: 0;
}
.mp-card-src {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
  color: var(--beet-soft); margin-top: 6px; text-transform: uppercase;
}
.mp-card-blurb { font-size: 14px; line-height: 1.5; margin: 10px 0 0; }
.mp-meta {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px;
  font-family: var(--mono); font-size: 11px; color: var(--beet-soft);
}
.mp-meta span { display: inline-flex; align-items: center; gap: 4px; }
.mp-card-acts { display: flex; gap: 8px; margin-top: 13px; }
.mp-btn {
  padding: 9px 14px; border-radius: 9px; font-size: 13px; font-weight: 700;
  border: 1.5px solid var(--beet); color: var(--beet); background: transparent;
  transition: background .15s, color .15s;
}
.mp-btn:hover { background: var(--beet); color: #FFF7FA; }
.mp-btn-fill { background: var(--leaf); border-color: var(--leaf); color: #F2F8F4; }
.mp-btn-fill:hover { background: #24553E; border-color: #24553E; color: #F2F8F4; }

.mp-pick {
  flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%;
  border: 2px solid var(--line); background: var(--paper);
  display: grid; place-items: center; font-size: 15px; color: transparent;
  transition: background .16s, border-color .16s, color .16s;
}
.mp-pick[data-on="true"] { background: var(--leaf); border-color: var(--leaf); color: #F2F8F4; }

/* ---- detail sheet ---- */
.mp-scrim {
  position: fixed; inset: 0; z-index: 60; background: rgba(40,14,26,.55);
  display: flex; align-items: flex-end; justify-content: center;
  animation: mp-fade .18s ease-out;
}
@keyframes mp-fade { from { opacity: 0 } }
@keyframes mp-rise { from { transform: translateY(22px) } }
.mp-sheet {
  background: var(--paper); width: 100%; max-width: 700px;
  max-height: 92vh; overflow-y: auto;
  border-radius: 20px 20px 0 0; padding: 22px 20px 40px;
  animation: mp-rise .22s ease-out;
}
.mp-sheet h2 {
  font-family: var(--display); font-weight: 800; font-size: 28px;
  line-height: 1.05; letter-spacing: -.028em; color: var(--beet); margin: 10px 0 0;
}
.mp-grab { width: 42px; height: 4px; border-radius: 3px; background: var(--line); margin: 0 auto 6px; }
.mp-h3 {
  font-family: var(--mono); font-size: 11px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--beet-soft);
  margin: 26px 0 10px; padding-bottom: 7px; border-bottom: 1.5px solid var(--line);
}
.mp-ing { list-style: none; padding: 0; margin: 0; }
.mp-ing li {
  display: flex; gap: 10px; padding: 7px 0; font-size: 14.5px;
  border-bottom: 1px dotted var(--line);
}
.mp-ing b { font-family: var(--mono); font-weight: 700; color: var(--beet); min-width: 72px; }
.mp-steps { list-style: none; counter-reset: s; padding: 0; margin: 0; }
.mp-steps li {
  counter-increment: s; position: relative; padding: 0 0 16px 34px;
  font-size: 14.5px; line-height: 1.58;
}
.mp-steps li::before {
  content: counter(s); position: absolute; left: 0; top: 1px;
  width: 23px; height: 23px; border-radius: 50%;
  background: var(--beet); color: #FFF7FA;
  font-family: var(--mono); font-size: 11px; font-weight: 700;
  display: grid; place-items: center;
}
.mp-tagrow { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.mp-tag {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .05em;
  padding: 4px 9px; border-radius: 999px; background: var(--leaf-soft);
  color: var(--leaf); text-transform: uppercase;
}

/* ---- saved rows ---- */
.mp-row {
  display: flex; align-items: center; gap: 12px; background: var(--paper);
  border: 1.5px solid var(--line); border-radius: 13px; padding: 13px 14px;
}
.mp-row-main { flex: 1; min-width: 0; text-align: left; }
.mp-row-name {
  font-family: var(--display); font-weight: 700; font-size: 16px;
  color: var(--beet); letter-spacing: -.015em; line-height: 1.2;
}
.mp-row-meta { font-family: var(--mono); font-size: 10.5px; color: var(--beet-soft); margin-top: 5px; }
.mp-step {
  display: flex; align-items: center; border: 1.5px solid var(--line);
  border-radius: 9px; overflow: hidden; background: var(--blush);
}
.mp-step button { width: 30px; height: 32px; font-size: 16px; color: var(--beet); line-height: 1; }
.mp-step button:disabled { opacity: .3; cursor: not-allowed; }
.mp-step span {
  font-family: var(--mono); font-size: 12px; font-weight: 700;
  width: 30px; text-align: center; color: var(--beet);
}

/* ---- the receipt ---- */
.mp-receipt {
  background: var(--paper); padding: 26px 20px 20px;
  box-shadow: 0 2px 0 rgba(88,32,60,.07);
  font-family: var(--mono);
}
.mp-tear {
  height: 13px;
  background-image:
    linear-gradient(135deg, var(--paper) 50%, transparent 50%),
    linear-gradient(-135deg, var(--paper) 50%, transparent 50%);
  background-size: 16px 16px; background-repeat: repeat-x;
}
.mp-r-head { text-align: center; padding-bottom: 16px; border-bottom: 2px dashed var(--line); }
.mp-r-head h2 {
  font-family: var(--display); font-weight: 800; font-size: 22px;
  letter-spacing: .02em; color: var(--beet); margin: 0 0 6px; text-transform: uppercase;
}
.mp-r-head p { margin: 0; font-size: 11px; letter-spacing: .1em; color: var(--beet-soft); }
.mp-aisle {
  font-size: 11px; letter-spacing: .18em; text-transform: uppercase;
  color: var(--beet); font-weight: 700; margin: 22px 0 2px;
}
.mp-r-item {
  display: flex; align-items: baseline; width: 100%; gap: 6px;
  padding: 8px 0; text-align: left; font-size: 13.5px; color: var(--slate);
  border-bottom: 1px dotted var(--line);
}
.mp-box {
  flex: 0 0 auto; width: 15px; height: 15px; border: 1.5px solid var(--beet-soft);
  border-radius: 3px; display: grid; place-items: center;
  font-size: 11px; line-height: 1; color: transparent; align-self: center;
}
.mp-r-item[data-on="true"] { color: #B4A3AB; }
.mp-r-item[data-on="true"] .mp-name { text-decoration: line-through; }
.mp-r-item[data-on="true"] .mp-box { background: var(--leaf); border-color: var(--leaf); color: #F2F8F4; }
.mp-name { flex: 1; }
.mp-dots { flex: 1; border-bottom: 1px dotted var(--line); transform: translateY(-3px); min-width: 12px; }
.mp-amt { flex: 0 0 auto; font-weight: 700; color: var(--beet); }
.mp-r-item[data-on="true"] .mp-amt { color: #B4A3AB; }
.mp-from { font-size: 10px; color: #A8949C; letter-spacing: .04em; margin-top: 2px; }
.mp-total {
  margin-top: 26px; padding-top: 14px; border-top: 2px dashed var(--line);
  display: flex; justify-content: space-between; font-size: 12px;
  letter-spacing: .08em; text-transform: uppercase; color: var(--beet); font-weight: 700;
}

/* ---- empty ---- */
.mp-empty {
  border: 2px dashed var(--line); border-radius: 16px;
  padding: 40px 24px; text-align: center;
}
.mp-empty h3 {
  font-family: var(--display); font-weight: 800; font-size: 22px;
  color: var(--beet); margin: 0 0 8px; letter-spacing: -.02em;
}
.mp-empty p { margin: 0 auto; max-width: 34ch; font-size: 14px; line-height: 1.55; }

.mp-bar {
  display: flex; gap: 8px; align-items: center; justify-content: space-between;
  margin-bottom: 14px; flex-wrap: wrap;
}
.mp-mini {
  font-family: var(--mono); font-size: 11px; letter-spacing: .07em;
  text-transform: uppercase; color: var(--beet-soft);
  border: 1.5px solid var(--line); border-radius: 999px; padding: 7px 12px;
  background: var(--paper);
}
.mp-note { font-size: 12.5px; line-height: 1.5; color: var(--beet-soft); margin: 16px 2px 0; }

@media (min-width: 640px) {
  .mp-grid { grid-template-columns: 1fr 1fr; }
  .mp-scrim { align-items: center; }
  .mp-sheet { border-radius: 18px; max-height: 86vh; }
}
@media (prefers-reduced-motion: reduce) {
  .mp *, .mp *::before { animation: none !important; transition: none !important; }
}
`;

/* ------------------------------------------------------------------ *
 *  COMPONENT
 * ------------------------------------------------------------------ */

export default function MealPrepPlanner() {
  const [tab, setTab] = useState("browse");
  const [cat, setCat] = useState("All");
  const [saved, setSaved] = useState({}); // id -> batches
  const [checked, setChecked] = useState({}); // key -> true
  const [open, setOpen] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [warn, setWarn] = useState("");

  /* load once */
  useEffect(() => {
    let alive = true;
    (async () => {
      let s = {},
        c = {};
      try {
        const r = await window.storage.get(STORE_KEY_SAVED);
        if (r && r.value) s = JSON.parse(r.value);
      } catch (e) {
        /* nothing saved yet */
      }
      try {
        const r = await window.storage.get(STORE_KEY_CHECKED);
        if (r && r.value) c = JSON.parse(r.value);
      } catch (e) {
        /* nothing saved yet */
      }
      if (!alive) return;
      setSaved(s);
      setChecked(c);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* persist */
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await window.storage.set(STORE_KEY_SAVED, JSON.stringify(saved));
        setWarn("");
      } catch (e) {
        setWarn("Picks aren't saving right now — they'll last until you close this.");
      }
    })();
  }, [saved, loaded]);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await window.storage.set(STORE_KEY_CHECKED, JSON.stringify(checked));
      } catch (e) {
        /* non-critical */
      }
    })();
  }, [checked, loaded]);

  const toggle = useCallback((id) => {
    setSaved((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = 1;
      return next;
    });
  }, []);

  const setBatch = useCallback((id, n) => {
    setSaved((prev) => ({ ...prev, [id]: Math.max(1, Math.min(4, n)) }));
  }, []);

  const savedRecipes = useMemo(
    () => RECIPES.filter((r) => saved[r.id]),
    [saved]
  );

  const visible = useMemo(
    () => (cat === "All" ? RECIPES : RECIPES.filter((r) => r.cat === cat)),
    [cat]
  );

  /* ---- grocery aggregation ---- */
  const groceries = useMemo(() => {
    const bucket = new Map();
    for (const r of savedRecipes) {
      const mult = saved[r.id] || 1;
      for (const ing of r.ing) {
        const key = `${ing.item.toLowerCase()}|${ing.unit}`;
        if (!bucket.has(key)) {
          bucket.set(key, {
            key,
            item: ing.item,
            unit: ing.unit,
            aisle: ing.aisle,
            qty: 0,
            from: new Set(),
          });
        }
        const b = bucket.get(key);
        b.qty += ing.qty * mult;
        b.from.add(r.name);
      }
    }
    const byAisle = {};
    for (const b of bucket.values()) {
      (byAisle[b.aisle] = byAisle[b.aisle] || []).push(b);
    }
    return AISLE_ORDER.filter((a) => byAisle[a]).map((a) => ({
      aisle: a,
      items: byAisle[a].sort((x, y) => x.item.localeCompare(y.item)),
    }));
  }, [savedRecipes, saved]);

  const totalItems = groceries.reduce((n, g) => n + g.items.length, 0);
  const totalServings = savedRecipes.reduce(
    (n, r) => n + r.servings * (saved[r.id] || 1),
    0
  );
  const doneCount = groceries.reduce(
    (n, g) => n + g.items.filter((i) => checked[i.key]).length,
    0
  );

  const pickedCount = savedRecipes.length;

  /* ---- render ---- */
  return (
    <div className="mp">
      <style>{CSS}</style>
      <div className="mp-wrap">
        <header className="mp-head">
          <div className="mp-eyebrow">24 recipes · sourced &amp; credited</div>
          <h1 className="mp-title">
            Cook once.
            <br />
            <em>Eat all week.</em>
          </h1>
          <p className="mp-sub">
            Meal-prep recipes people actually make twice, pulled from Budget Bytes,
            Pinch of Yum, Downshiftology, GypsyPlate and Classpop. Pick what you
            want, and the shopping list writes itself.
          </p>
        </header>

        <nav className="mp-tabs">
          <button
            className="mp-tab"
            data-on={tab === "browse"}
            onClick={() => setTab("browse")}
          >
            Browse
          </button>
          <button
            className="mp-tab"
            data-on={tab === "picks"}
            onClick={() => setTab("picks")}
          >
            My picks
            {pickedCount > 0 && <span className="mp-tab-n">{pickedCount}</span>}
          </button>
          <button
            className="mp-tab"
            data-on={tab === "list"}
            onClick={() => setTab("list")}
          >
            Grocery list
          </button>
        </nav>

        {warn && <p className="mp-note">{warn}</p>}

        {/* ---------------- BROWSE ---------------- */}
        {tab === "browse" && (
          <>
            <div className="mp-chips">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  className="mp-chip"
                  data-on={cat === c}
                  onClick={() => setCat(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="mp-grid">
              {visible.map((r) => (
                <article key={r.id} className="mp-card" data-on={!!saved[r.id]}>
                  <div className="mp-card-top">
                    <div>
                      <h3 className="mp-card-name">{r.name}</h3>
                      <div className="mp-card-src">{r.source}</div>
                    </div>
                    <button
                      className="mp-pick"
                      data-on={!!saved[r.id]}
                      aria-pressed={!!saved[r.id]}
                      aria-label={
                        saved[r.id] ? `Remove ${r.name}` : `Save ${r.name}`
                      }
                      onClick={() => toggle(r.id)}
                    >
                      ✓
                    </button>
                  </div>
                  <p className="mp-card-blurb">{r.blurb}</p>
                  <div className="mp-meta">
                    <span>{fmtTime(r.time)}</span>
                    <span>{r.servings} servings</span>
                    <span>keeps {r.keeps}</span>
                  </div>
                  <div className="mp-card-acts">
                    <button
                      className={saved[r.id] ? "mp-btn" : "mp-btn mp-btn-fill"}
                      onClick={() => toggle(r.id)}
                    >
                      {saved[r.id] ? "Remove" : "Save it"}
                    </button>
                    <button className="mp-btn" onClick={() => setOpen(r)}>
                      Recipe
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

        {/* ---------------- PICKS ---------------- */}
        {tab === "picks" && (
          <>
            {pickedCount === 0 ? (
              <div className="mp-empty">
                <h3>Nothing saved yet</h3>
                <p>
                  Head to Browse and save a few. Four or five recipes usually
                  covers a week without you getting bored of any one of them.
                </p>
              </div>
            ) : (
              <>
                <div className="mp-bar">
                  <div className="mp-mini">
                    {pickedCount} recipes · {totalServings} servings
                  </div>
                  <button className="mp-mini" onClick={() => setSaved({})}>
                    Clear all
                  </button>
                </div>
                <div className="mp-grid" style={{ gridTemplateColumns: "1fr" }}>
                  {savedRecipes.map((r) => (
                    <div key={r.id} className="mp-row">
                      <button
                        className="mp-row-main"
                        onClick={() => setOpen(r)}
                      >
                        <div className="mp-row-name">{r.name}</div>
                        <div className="mp-row-meta">
                          {fmtTime(r.time)} · {r.servings * saved[r.id]} servings
                          · keeps {r.keeps}
                        </div>
                      </button>
                      <div className="mp-step">
                        <button
                          onClick={() => setBatch(r.id, saved[r.id] - 1)}
                          disabled={saved[r.id] <= 1}
                          aria-label={`Fewer batches of ${r.name}`}
                        >
                          −
                        </button>
                        <span aria-label="batches">{saved[r.id]}×</span>
                        <button
                          onClick={() => setBatch(r.id, saved[r.id] + 1)}
                          disabled={saved[r.id] >= 4}
                          aria-label={`More batches of ${r.name}`}
                        >
                          +
                        </button>
                      </div>
                      <button
                        className="mp-pick"
                        data-on={true}
                        onClick={() => toggle(r.id)}
                        aria-label={`Remove ${r.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <p className="mp-note">
                  Tap a recipe to read it. The multiplier scales that recipe's
                  ingredients on the grocery list — useful when one dish is doing
                  double duty as lunch and dinner.
                </p>
              </>
            )}
          </>
        )}

        {/* ---------------- GROCERY LIST ---------------- */}
        {tab === "list" && (
          <>
            {pickedCount === 0 ? (
              <div className="mp-empty">
                <h3>The list builds itself</h3>
                <p>
                  Save some recipes and everything they need shows up here,
                  combined and sorted in the order you'll walk the store.
                </p>
              </div>
            ) : (
              <>
                <div className="mp-bar">
                  <div className="mp-mini">
                    {doneCount} of {totalItems} in the cart
                  </div>
                  <button className="mp-mini" onClick={() => setChecked({})}>
                    Uncheck all
                  </button>
                </div>

                <div className="mp-receipt">
                  <div className="mp-r-head">
                    <h2>Shopping list</h2>
                    <p>
                      {pickedCount} RECIPES · {totalServings} SERVINGS ·{" "}
                      {totalItems} ITEMS
                    </p>
                  </div>

                  {groceries.map((g) => (
                    <section key={g.aisle}>
                      <div className="mp-aisle">{g.aisle}</div>
                      {g.items.map((i) => {
                        const on = !!checked[i.key];
                        const from = [...i.from];
                        return (
                          <button
                            key={i.key}
                            className="mp-r-item"
                            data-on={on}
                            aria-pressed={on}
                            onClick={() =>
                              setChecked((p) => {
                                const n = { ...p };
                                if (n[i.key]) delete n[i.key];
                                else n[i.key] = true;
                                return n;
                              })
                            }
                          >
                            <span className="mp-box">✓</span>
                            <span className="mp-name">
                              {i.item}
                              {from.length > 1 && (
                                <span className="mp-from">
                                  <br />
                                  for {from.length} recipes
                                </span>
                              )}
                            </span>
                            <span className="mp-dots" />
                            <span className="mp-amt">
                              {fmtLine(i.qty, i.unit)}
                            </span>
                          </button>
                        );
                      })}
                    </section>
                  ))}

                  <div className="mp-total">
                    <span>Total</span>
                    <span>
                      {totalItems} items · {totalServings} meals
                    </span>
                  </div>
                </div>
                <div className="mp-tear" />

                <p className="mp-note">
                  Aisles run in the order most stores are laid out, with frozen
                  last so nothing melts on the walk to the register. Shared
                  ingredients are already added together. Check-offs stay put if
                  you close this and come back mid-shop.
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* ---------------- DETAIL SHEET ---------------- */}
      {open && (
        <div
          className="mp-scrim"
          onClick={(e) => e.target === e.currentTarget && setOpen(null)}
        >
          <div className="mp-sheet" role="dialog" aria-label={open.name}>
            <div className="mp-grab" />
            <div className="mp-card-src">{open.source}</div>
            <h2>{open.name}</h2>
            <div className="mp-meta">
              <span>{fmtTime(open.time)}</span>
              <span>{open.servings} servings</span>
              <span>keeps {open.keeps}</span>
            </div>
            <div className="mp-tagrow">
              {open.tags.map((t) => (
                <span key={t} className="mp-tag">
                  {t}
                </span>
              ))}
            </div>

            <div className="mp-h3">
              Ingredients
              {saved[open.id] > 1 ? ` — shown at 1×, list uses ${saved[open.id]}×` : ""}
            </div>
            <ul className="mp-ing">
              {open.ing.map((i, n) => (
                <li key={n}>
                  <b>{fmtLine(i.qty, i.unit)}</b>
                  <span>{i.item}</span>
                </li>
              ))}
            </ul>

            <div className="mp-h3">Method</div>
            <ol className="mp-steps">
              {open.steps.map((s, n) => (
                <li key={n}>{s}</li>
              ))}
            </ol>

            <div className="mp-card-acts" style={{ marginTop: 24 }}>
              <button
                className={saved[open.id] ? "mp-btn" : "mp-btn mp-btn-fill"}
                onClick={() => toggle(open.id)}
              >
                {saved[open.id] ? "Remove from picks" : "Save it"}
              </button>
              <button className="mp-btn" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
