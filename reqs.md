# Recipe Planner

## Main Goals
1) Daily scan using cheap LLM (possibly self hosted) over some agentic harness (likely pi) to grab new and recommended recipes from a whole bunch of sites and social media. Save the recipes and ingredients to some database to format for frontend, and maybe some pictures/reviews

2) Sign in with some sort of oauth (Google/Apple), to save your favourite recipes. 

3) From saved recipes, generate a grocery list of everything needed to make all the recipes in your saved lists.

4) Once you make something, have the ability to rate it, and say what you liked/didn't like about it (quick to make, cheap, good, etc)

5) Over time, as you make more and more recipes and reate them, the LLM scanner will prioritize things it thinks you'll like based on how you rated them, and drop things you probably won't like (e.g. if I don't like things that take more than 1 hour, don't show it)