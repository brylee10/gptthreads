# GPT Threads ![icon](src/assets/activeThread.svg)
A chrome extension which allows you to start a chat with GPT directly in a webpage with a click by highlighting relevant text and asking a question. 

<p align="center">
    <img src="https://i.imgur.com/rPxJE2w.gif" alt="ChatGPT follow-up threads demo" width="400"/>
</p>

## Demos
* Start subthreads with GPT (the namesake): Start multiple follow-up threads with GPT, focusing on different highlighted text while incorporating surrounding context. 

<p align="center">
    <img src="https://i.imgur.com/xTB000b.png" alt="ChatGPT follow-up threads demo" width="800"/>
</p>

* Summarize documents, focusing on a subtext (purple highlight) and taking surrounding text as context (gray highlight, which can be optionally displayed via configuration) 

<p align="center">
    <img src="https://i.imgur.com/o5XHC7f.png" alt="Article summary demo" width="800">
</p>

* Get additional context on terminology and concepts in articles

<p align="center">
    <img src="https://i.imgur.com/VqKGf4Y.png" alt="Clarifying terminology and concepts demo" width="800">
</p>

## Features
Some of the chat features include:
* Start a chat on (almost) any webpage 
* Supports Open AI chat and reasoning models
* Uses highlighted text and surrounding context to ground the question
* Supports multiple concurrent chats on a page which persist as long as the page is loaded 
* Customizable chat box placement and sizing
* Markdown and LaTeX formatting support

Additionally, your API key is stored locally on the Chrome browser and not shared.

## Getting Started
1. Download the Chrome extension
2. Add your OpenAI API key in the extension settings
3. Highlight text on any webpage
4. Start chatting with GPT!

## Motivation
The original motivation for this project (and the reason for the name) was  that current LLM chat apps don't natively support "threads" which would facilitate in-context follow-ups without jumping around chat history (like with quotes). With conversation threads, chats could be more similar a branching tree of exploring follow-ups rather than one straight-shot line to the answer. These can be particularly useful for complicated topics where one long GPT response prompts many follow-up questions. Given this, the original intention was to use this extension as a temporary bandaid in ChatGPT in hopes one day threads would be implemented. In practice, this can be a low friction way to start chats with GPT using context from news sites, documentation pages, or any site of your choice.  

## Configuration
The extension can be customized through the extension popup menu:

<p align="center">
    <img src="https://i.imgur.com/MRx6gij.jpg" alt="Example GPT Threads Configuration" width="200">
</p>

### Model Settings
- **Model Version**: Choose from various GPT models (e.g. gpt-4o, o3-mini)
- **Surrounding Context**: Control how many surrounding words around your highlight are included in the context (total, split roughly equal above and below). 
- **Max Response Words**: Approx maximum words in the model response.

### Interface Settings
- **Use Previous Box Placement**: If enabled, keep customized chat chat box locations if chats are dragged. Applies to current tab.
- **Use Previous Chat Box Size**: If enabled, keep customized chat box sizes if chats are resized. Applies to current tab.
- **Show Context highlights**: Enable highlights to visualize the surrounding context being sent to the model
- **Extension Toggle**: Enable/disable the extension